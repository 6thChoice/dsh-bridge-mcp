/**
 * Staging harness for integration tests (spec §11).
 *
 * Spawns the packaged `dsh web --no-open --port 0` with a temp DSH_HOME and a
 * local stub provider. The stub speaks both wire formats the DSH builds in the
 * wild use: Anthropic Messages (`/v1/messages`, 0.2.x `deepseek-official`) and
 * OpenAI-completions (`/chat/completions`) — the tool never sees either.
 *
 * No test ever prompts a real user session.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SessionClient,
  sessionCursor,
  stripSessionPrefix,
  type SessionRow,
} from '../src/client.js';
import { CredentialsError } from '../src/errors.js';
import { loadBrowserSessionSecret } from '../src/auth.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DSH_BIN =
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';

export interface StubRequest {
  path: string;
  body: Record<string, unknown>;
  /** The title-generation request, not an agent turn. */
  isTitle: boolean;
  /** The request's conversation already contains a tool result. */
  hasToolResult: boolean;
  /** First text block of the last user message (the human prompt). */
  lastHumanText: string;
  /** 1-based index among agent requests only. */
  agentIndex: number;
}

export interface StubResponse {
  text?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  delayMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type StubHandler = (request: StubRequest) => StubResponse;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function humanTextOf(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = asRecord(messages[index]);
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const record = asRecord(block);
      if (record?.type === 'text' && typeof record.text === 'string') return record.text;
    }
    return '';
  }
  return '';
}

export class StubProvider {
  private server: Server | null = null;
  private handler: StubHandler = () => ({ text: 'PONG' });
  private agentRequests = 0;
  readonly requests: StubRequest[] = [];
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  setHandler(handler: StubHandler): void {
    this.handler = handler;
  }

  /** The agent requests (title calls excluded), in arrival order. */
  get agentCalls(): StubRequest[] {
    return this.requests.filter((request) => !request.isTitle);
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown> = {};
        try {
          body = asRecord(JSON.parse(raw)) ?? {};
        } catch {
          body = {};
        }
        const path = request.url ?? '';
        const messages = Array.isArray(body.messages) ? body.messages : [];
        // Only the request's own messages/system matter: DSH also ships a
        // `dsh_session_log` snapshot whose title-request text must not be
        // mistaken for this call's purpose.
        const messagesText = JSON.stringify(messages);
        const systemText = typeof body.system === 'string' ? body.system : '';
        const isTitle =
          systemText.includes('Create a concise title') ||
          messagesText.includes('Generate the session title');
        const hasToolResult =
          messagesText.includes('"tool_result"') ||
          messages.some((message) => asRecord(message)?.role === 'tool');

        if (!isTitle) this.agentRequests += 1;
        const context: StubRequest = {
          path,
          body,
          isTitle,
          hasToolResult,
          lastHumanText: humanTextOf(body),
          agentIndex: this.agentRequests,
        };
        this.requests.push(context);

        const answer: StubResponse = isTitle
          ? { text: 'Staging Title' }
          : this.handler(context);
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        setTimeout(() => {
          if (response.destroyed) return;
          try {
            if (path.includes('/messages')) this.emitAnthropic(response, answer);
            else this.emitOpenAi(response, answer);
          } catch {
            // The test may have torn the staging instance down first.
          }
        }, answer.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('stub provider has no port');
    this.port = address.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }

  private emitAnthropic(response: import('node:http').ServerResponse, answer: StubResponse): void {
    const usage = { inputTokens: answer.usage?.inputTokens ?? 10, outputTokens: answer.usage?.outputTokens ?? 2 };
    const writeEvent = (type: string, value: unknown): void => {
      response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
    };
    writeEvent('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${String(Date.now())}`,
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.inputTokens, output_tokens: 0 },
      },
    });
    let index = 0;
    const text = answer.text ?? (answer.toolCall === undefined ? 'OK' : '');
    if (text !== '') {
      writeEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      writeEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text },
      });
      writeEvent('content_block_stop', { type: 'content_block_stop', index });
      index += 1;
    }
    if (answer.toolCall !== undefined) {
      writeEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: `toolu_${String(Date.now())}`,
          name: answer.toolCall.name,
          input: {},
        },
      });
      writeEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(answer.toolCall.args) },
      });
      writeEvent('content_block_stop', { type: 'content_block_stop', index });
    }
    writeEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: answer.toolCall === undefined ? 'end_turn' : 'tool_use',
        stop_sequence: null,
      },
      usage: { output_tokens: usage.outputTokens },
    });
    writeEvent('message_stop', { type: 'message_stop' });
    response.end();
  }

  private emitOpenAi(response: import('node:http').ServerResponse, answer: StubResponse): void {
    const usage = { inputTokens: answer.usage?.inputTokens ?? 10, outputTokens: answer.usage?.outputTokens ?? 2 };
    const chunk = (delta: Record<string, unknown>, finish: string | null): void => {
      response.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'deepseek-chat',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    };
    chunk({ role: 'assistant', content: answer.toolCall === undefined ? (answer.text ?? 'OK') : '' }, null);
    if (answer.toolCall !== undefined) {
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: `call_${String(Date.now())}`,
              type: 'function',
              function: { name: answer.toolCall.name, arguments: JSON.stringify(answer.toolCall.args) },
            },
          ],
        },
        null,
      );
    }
    response.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-stub',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta: {}, finish_reason: answer.toolCall === undefined ? 'stop' : 'tool_calls' }],
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.inputTokens + usage.outputTokens,
        },
      })}\n\n`,
    );
    response.write('data: [DONE]\n\n');
    response.end();
  }
}

export interface Staging {
  url: string;
  home: string;
  sessionId: string;
  client: SessionClient;
  stub: StubProvider;
  createSession(): Promise<string>;
  stop(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Spawn a disposable DSH Web host plus stub provider. */
export async function startStaging(): Promise<Staging> {
  const dshBin = process.env.DSH_BIN ?? DEFAULT_DSH_BIN;
  if (!existsSync(dshBin)) {
    throw new Error(
      `staging tests need the packaged dsh CLI at ${dshBin}; set DSH_BIN to another dsh 0.2.x binary`,
    );
  }
  const stub = new StubProvider();
  await stub.start();
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-staging-'));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DSH_BRIDGE_HOST;
  delete env.DSH_BRIDGE_TIMEOUT;
  delete env.DSH_BRIDGE_FROM;
  Object.assign(env, {
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(home, 'agents'),
    DEEPSEEK_API_KEY: 'dummy',
    DEEPSEEK_BASE_URL: stub.url,
  });

  const child = spawn(dshBin, ['web', '--no-open', '--port', '0'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const consume = (chunk: Buffer): void => {
    output += chunk.toString();
    if (output.length > 200_000) output = output.slice(-100_000);
  };
  child.stdout?.on('data', consume);
  child.stderr?.on('data', consume);

  const launchUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`dsh web did not become ready in 90s; output:\n${output}`));
    }, 90_000);
    const inspect = (): void => {
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(output);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout?.on('data', inspect);
    child.stderr?.on('data', inspect);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`dsh web exited early (code ${String(code)}); output:\n${output}`));
    });
  });
  const origin = new URL(launchUrl).origin;

  // The browser-session secret is minted when the Connection activates.
  let readySecret = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      loadBrowserSessionSecret(home);
      readySecret = true;
      break;
    } catch (error) {
      if (!(error instanceof CredentialsError)) throw error;
      await sleep(50);
    }
  }
  if (!readySecret) {
    child.kill('SIGKILL');
    await stub.stop();
    rmSync(home, { recursive: true, force: true });
    throw new Error(`dsh web did not mint a browser-session secret; output:\n${output}`);
  }

  const client = await SessionClient.connect({ host: origin, dshHome: home });
  const createSession = async (): Promise<string> => {
    const created = await client.rpc<unknown>('session/create', { request: {} });
    const record = asRecord(created);
    if (typeof record?.sessionId !== 'string') {
      throw new Error(`session/create returned no sessionId: ${JSON.stringify(created)}`);
    }
    return record.sessionId;
  };
  const sessionId = await createSession();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await stopChild(child);
    await stub.stop();
    rmSync(home, { recursive: true, force: true });
  };

  return { url: origin, home, sessionId, client, stub, createSession, stop };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      child.once('exit', () => {
        resolve(true);
      });
    }),
    sleep(5000).then(() => false),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });
  }
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the built CLI with the staging DSH home. Async on purpose: the stub
 * provider lives in this process, so a synchronous spawn would deadlock it.
 */
export function runCli(
  args: string[],
  options: { home: string; env?: NodeJS.ProcessEnv } = { home: '' },
): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  delete env.DSH_BRIDGE_HOST;
  if (options.home !== '') env.DSH_HOME = options.home;
  return new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'dist', 'cli.js'), ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit in 120s; stdout=${stdout} stderr=${stderr}`));
    }, 120_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function rowFor(client: SessionClient, sessionId: string): Promise<SessionRow> {
  const wanted = stripSessionPrefix(sessionId);
  const row = (await client.listSessions()).find(
    (candidate) => stripSessionPrefix(candidate.sessionId) === wanted,
  );
  if (row === undefined) throw new Error(`session ${sessionId} is missing from session/list`);
  return row;
}

/** Wait until the session reports `running: true` (a turn is in flight). */
export async function waitUntilRunning(
  client: SessionClient,
  sessionId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await rowFor(client, sessionId);
    if (row.running === true) return;
    if (Date.now() > deadline) throw new Error(`session ${sessionId} never reported running`);
    await sleep(100);
  }
}

/** Read the session's durable log and report whether an rpcId landed there. */
export async function logHasRpcId(
  client: SessionClient,
  sessionId: string,
  rpcId: string,
): Promise<boolean> {
  const row = await rowFor(client, sessionId);
  const cursor = sessionCursor(row);
  if (cursor === undefined) return false;
  const page = await client.pageSession(sessionId, cursor, 100);
  return page.records.some((record) => {
    if (record.type !== 'event') return false;
    const event = asRecord(record.event);
    if (event?.type !== 'user/message') return false;
    const data = asRecord(event.data);
    const source = asRecord(data?.source);
    return source?.kind === 'user' && source.rpcId === rpcId;
  });
}

