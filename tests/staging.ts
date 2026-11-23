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
import {
  accessSync,
  constants,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SessionClient,
  sessionCursor,
  stripSessionPrefix,
  type SessionRow,
} from '../src/client.js';
import { resolveHost } from '../src/host.js';
import { CredentialsError } from '../src/errors.js';
import { loadBrowserSessionSecret } from '../src/auth.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Standard install location of the packaged CLI, used only as a last resort. */
export const MACOS_DSH_BIN =
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';

export interface DshBinaryResolution {
  /** The runnable binary, when one was found. */
  binary?: string;
  source: 'DSH_BIN' | 'PATH' | 'macOS app' | 'none';
  /** Why no binary was found; used verbatim in the self-skip message. */
  reason?: string;
}

export interface ResolveDshBinaryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test seam: pretend a path is (or is not) a runnable executable. */
  isRunnable?: (path: string) => boolean;
}

function runnableOn(platform: NodeJS.Platform): (path: string) => boolean {
  return (path: string): boolean => {
    try {
      if (!statSync(path).isFile()) return false;
      if (platform !== 'win32') accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

function findOnPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isRunnable: (path: string) => boolean,
): string | undefined {
  const rawPath = env.PATH ?? env.Path ?? '';
  const names = platform === 'win32' ? ['dsh.exe', 'dsh.cmd', 'dsh'] : ['dsh'];
  for (const dir of rawPath.split(delimiter)) {
    if (dir === '') continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isRunnable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve a runnable `dsh` for the staging suites:
 * `DSH_BIN` → `dsh` on `PATH` → the macOS app-bundle path.
 *
 * A set-but-unrunnable `DSH_BIN` is authoritative (no further fallback): the
 * operator pinned a binary, so quietly using another one would test the wrong
 * thing. CI with no DSH therefore self-skips instead of failing.
 */
export function resolveDshBinary(options: ResolveDshBinaryOptions = {}): DshBinaryResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isRunnable = options.isRunnable ?? runnableOn(platform);

  const fromEnv = env.DSH_BIN;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (isRunnable(fromEnv)) return { binary: fromEnv, source: 'DSH_BIN' };
    return {
      source: 'none',
      reason: `DSH_BIN=${fromEnv} is not a runnable dsh (set DSH_BIN to a dsh >= 0.2 CLI)`,
    };
  }

  const onPath = findOnPath(env, platform, isRunnable);
  if (onPath !== undefined) return { binary: onPath, source: 'PATH' };

  if (platform === 'darwin' && isRunnable(MACOS_DSH_BIN)) {
    return { binary: MACOS_DSH_BIN, source: 'macOS app' };
  }

  const checked = platform === 'darwin' ? `, or the macOS app bundle at ${MACOS_DSH_BIN}` : '';
  return {
    source: 'none',
    reason:
      'no runnable dsh found (set DSH_BIN to a dsh >= 0.2 CLI, or put dsh on PATH' +
      `${checked})`,
  };
}

/** `false` when staging can run; otherwise the node:test skip reason. */
export function stagingSkipReason(options: ResolveDshBinaryOptions = {}): string | false {
  const resolution = resolveDshBinary(options);
  return resolution.binary === undefined
    ? `staging tests skipped: ${resolution.reason ?? 'no runnable dsh found'}`
    : false;
}

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
  const resolution = resolveDshBinary();
  const dshBin = resolution.binary;
  if (dshBin === undefined) {
    // Callers self-skip first; this is a guard for a direct `startStaging` call.
    throw new Error(`staging tests need a runnable dsh CLI: ${resolution.reason ?? 'none found'}`);
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

  // Explicit host + a nonexistent config path: staging stays independent of the
  // developer's real ~/.config/dsh-bridge/config.json.
  const resolved = await resolveHost({
    host: origin,
    dshHome: home,
    configPath: join(home, 'no-config.json'),
  });
  const client = new SessionClient(resolved.endpoint, resolved.cookie, {
    dshHome: resolved.dshHome,
    hostSource: resolved.source,
  });
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Keep the developer's real config file out of staging runs.
    XDG_CONFIG_HOME: join(tmpdir(), 'dsh-bridge-test-config-none'),
    ...options.env,
  };
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

