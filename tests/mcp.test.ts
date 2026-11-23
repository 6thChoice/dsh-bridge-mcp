/**
 * MCP stdio shell tests (ticket T2, spec §10).
 *
 * Two layers:
 *   - protocol unit tests against `handleRequest` (no host, no network);
 *   - the real bin driven over stdio: initialize/tools/list/ping, a read-only
 *     `dsh_sessions` against the live desktop host, `dsh_send`/`dsh_result`
 *     against T1's staging instance (spawned `dsh web` + stub provider), a
 *     failing tool call, an unknown method, and the stdin-EOF exit.
 *
 * Nothing here prompts a real user session.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { SessionClient, asRecord } from '../src/client.js';
import {
  LATEST_PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  handleRequest,
  toolNames,
} from '../src/mcp.js';
import { REPO_ROOT, startStaging, type Staging, type StubResponse } from './staging.js';

/* ------------------------------------------------------------------ driver */

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

const MCP_BIN = join(REPO_ROOT, 'dist', 'mcp.js');

/** One spawned `dsh-bridge-mcp`; every stdout line must be a JSON-RPC message. */
class McpClient {
  private readonly child: ChildProcess;
  private readonly responses = new Map<number, RpcMessage>();
  private readonly stdoutLines: string[] = [];
  private readonly unparsable: string[] = [];
  private waiters: (() => void)[] = [];
  private stderr = '';
  private nextId = 1;

  constructor(env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [MCP_BIN], {
      cwd: REPO_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = this.child.stdout;
    const stderr = this.child.stderr;
    assert.ok(stdout !== null && stderr !== null, 'child stdio must be piped');
    createInterface({ input: stdout, crlfDelay: Infinity }).on('line', (line: string) => {
      this.onLine(line);
    });
    stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
  }

  get exitCode(): Promise<number> {
    return new Promise<number>((resolve) => {
      if (this.child.exitCode !== null) {
        resolve(this.child.exitCode);
        return;
      }
      this.child.once('close', (code) => {
        resolve(code ?? 1);
      });
    });
  }

  stderrText(): string {
    return this.stderr;
  }

  /** Lines the server wrote to stdout that were not JSON (must stay empty). */
  unparsableLines(): string[] {
    return this.unparsable;
  }

  stdoutLineCount(): number {
    return this.stdoutLines.length;
  }

  private onLine(line: string): void {
    if (line.trim() === '') return;
    this.stdoutLines.push(line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.unparsable.push(line);
      return;
    }
    const message = asRecord(parsed);
    const id = message?.id;
    if (typeof id === 'number') this.responses.set(id, message as RpcMessage);
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private write(payload: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 180_000,
  ): Promise<RpcMessage> {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.responses.get(id);
      if (found !== undefined) {
        this.responses.delete(id);
        return found;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `no response for request ${id} (${method}) within ${String(timeoutMs)}ms; ` +
            `stdout=${this.stdoutLines.join(' | ')} stderr=${this.stderr}`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('timeout'));
        }, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      }).catch(() => {
        // Re-checked by the loop condition above.
      });
    }
  }

  async initialize(): Promise<RpcMessage> {
    return this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-bridge-tests', version: '0.0.0' },
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 180_000,
  ): Promise<RpcMessage> {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }

  /** Close stdin and wait for the server to exit on its own. */
  async close(timeoutMs = 15_000): Promise<number> {
    this.child.stdin?.end();
    const code = await Promise.race([
      this.exitCode,
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve('timeout');
        }, timeoutMs);
      }),
    ]);
    if (code === 'timeout') {
      this.child.kill('SIGKILL');
      throw new Error(`MCP server did not exit after stdin EOF; stderr=${this.stderr}`);
    }
    return code as number;
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

/** Child env: inherit, then drop the variables these tests pin explicitly. */
function childEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['DSH_BRIDGE_FROM', 'DSH_BRIDGE_TIMEOUT']) delete env[key];
  return { ...env, ...overrides };
}

function resultOf(message: unknown): Record<string, unknown> {
  const result = asRecord(asRecord(message)?.result);
  assert.ok(result !== undefined, `response has no result object: ${JSON.stringify(message)}`);
  return result;
}

function errorOf(message: unknown): Record<string, unknown> {
  const error = asRecord(asRecord(message)?.error);
  assert.ok(error !== undefined, `response has no error object: ${JSON.stringify(message)}`);
  return error;
}

interface ToolPayload {
  content: { type?: unknown; text?: unknown }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function toolPayloadOf(message: unknown): ToolPayload {
  const result = resultOf(message);
  const content = result.content;
  assert.ok(Array.isArray(content), `tools/call result has no content array: ${JSON.stringify(result)}`);
  return result as unknown as ToolPayload;
}

/* ------------------------------------------------------ protocol unit tests */

test('initialize advertises the three-tool server and echoes a supported version', async () => {
  const response = await handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'unit' } },
  });
  const result = resultOf(response);
  assert.equal(result.protocolVersion, '2025-03-26');
  assert.deepEqual(result.serverInfo, { name: SERVER_NAME, version: SERVER_VERSION });
  assert.equal(typeof SERVER_VERSION, 'string');
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+/);
  assert.ok(asRecord(result.capabilities)?.tools !== undefined, 'capabilities.tools must be present');

  const unknownVersion = await handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  });
  assert.equal(resultOf(unknownVersion).protocolVersion, LATEST_PROTOCOL_VERSION);
});

test('tools/list returns exactly the three spec tools with their input schemas', async () => {
  const response = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const result = resultOf(response);
  const tools = result.tools;
  assert.ok(Array.isArray(tools));
  const list = tools as Record<string, unknown>[];
  assert.deepEqual(
    list.map((tool) => tool.name),
    ['dsh_send', 'dsh_result', 'dsh_sessions'],
  );
  assert.deepEqual(toolNames(), ['dsh_send', 'dsh_result', 'dsh_sessions']);
  assert.equal(list.length, 3);

  const expected: Record<string, string[]> = {
    dsh_send: ['target', 'text', 'from', 'timeoutSeconds', 'detach', 'prefix'],
    dsh_result: ['rpcId', 'wait', 'timeoutSeconds'],
    dsh_sessions: ['session', 'title', 'cwd', 'latest', 'limit'],
  };
  for (const tool of list) {
    const name = tool.name as string;
    assert.equal(tool.type, undefined, `${name} must not carry a stray type`);
    assert.equal(typeof tool.description, 'string');
    const schema = asRecord(tool.inputSchema);
    assert.ok(schema !== undefined, `${name} inputSchema must be an object`);
    assert.equal(schema.type, 'object');
    const properties = asRecord(schema.properties);
    assert.ok(properties !== undefined, `${name} inputSchema.properties must be an object`);
    assert.deepEqual(Object.keys(properties), expected[name]);
    for (const [key, value] of Object.entries(properties)) {
      assert.equal(typeof asRecord(value)?.type, 'string', `${name}.${key} needs a JSON type`);
    }
  }
  const send = asRecord(asRecord(list[0]?.inputSchema)?.properties);
  const target = asRecord(asRecord(send?.target)?.properties);
  assert.deepEqual(Object.keys(target ?? {}), ['session', 'title', 'cwd', 'latest']);
  assert.deepEqual(asRecord(list[0]?.inputSchema)?.required, ['text']);
  assert.deepEqual(asRecord(list[1]?.inputSchema)?.required, ['rpcId']);
});

test('unknown method is -32601 and notifications get no response', async () => {
  const unknown = await handleRequest({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
  assert.equal(errorOf(unknown).code, -32601);

  const initialized = await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(initialized, null);

  const ping = await handleRequest({ jsonrpc: '2.0', id: 10, method: 'ping' });
  assert.deepEqual(resultOf(ping as RpcMessage), {});
});

test('bad tool input is an isError result, never a transport error', async () => {
  const missingTarget = await handleRequest({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'dsh_send', arguments: { text: 'hi' } },
  });
  const noTarget = toolPayloadOf(missingTarget);
  assert.equal(noTarget.isError, true);
  assert.match(String(noTarget.content[0]?.text), /needs a target/);

  const emptyText = await handleRequest({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'dsh_send', arguments: { text: '  ', target: { latest: true } } },
  });
  const emptyPayload = toolPayloadOf(emptyText);
  assert.equal(emptyPayload.isError, true);
  assert.match(String(emptyPayload.content[0]?.text), /text must not be empty/);

  // dsh_sessions validates before it touches the network, so no host is needed.
  const badLimit = await handleRequest({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: { name: 'dsh_sessions', arguments: { limit: 'three' } },
  });
  const badLimitPayload = toolPayloadOf(badLimit);
  assert.equal(badLimitPayload.isError, true);
  assert.match(String(badLimitPayload.content[0]?.text), /limit must be a positive integer/);

  const unknownTool = await handleRequest({
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: { name: 'dsh_delete', arguments: {} },
  });
  assert.equal(errorOf(unknownTool).code, -32602);
  assert.match(String(errorOf(unknownTool).message), /dsh_send, dsh_result, dsh_sessions/);

  const badArguments = await handleRequest({
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: { name: 'dsh_sessions', arguments: [] },
  });
  assert.equal(errorOf(badArguments).code, -32602);

  const batch = await handleRequest([
    { jsonrpc: '2.0', id: 16, method: 'ping' },
  ]);
  assert.equal(errorOf(batch).code, -32600);
});

/* --------------------------------------------------------- stdio behaviour */

test('the built bin exits 0 on stdin EOF without hanging', { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, [MCP_BIN], {
    cwd: REPO_ROOT,
    env: childEnv({}),
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
  const code = await Promise.race([
    new Promise<number>((resolve) => {
      child.once('close', (closed) => {
        resolve(closed ?? 1);
      });
    }),
    new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve('timeout');
      }, 15_000);
    }),
  ]);
  if (code === 'timeout') {
    child.kill('SIGKILL');
    assert.fail(`node dist/mcp.js < /dev/null did not exit; stderr=${stderr}`);
  }
  assert.equal(code, 0, stderr);
  assert.equal(stdout, '');
});

test('initialize handshake, tools/list and an unknown method over real stdio', { timeout: 60_000 }, async () => {
  const mcp = new McpClient(childEnv({}));
  try {
    const initialized = await mcp.initialize();
    const handshake = resultOf(initialized);
    assert.deepEqual(handshake.serverInfo, { name: SERVER_NAME, version: SERVER_VERSION });
    assert.ok(asRecord(handshake.capabilities)?.tools !== undefined);
    mcp.notify('notifications/initialized');

    const listed = resultOf(await mcp.request('tools/list'));
    const tools = listed.tools as Record<string, unknown>[];
    assert.equal(tools.length, 3);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['dsh_send', 'dsh_result', 'dsh_sessions'],
    );

    const pong = resultOf(await mcp.request('ping'));
    assert.deepEqual(pong, {});

    const unknown = await mcp.request('dsh/nonexistent');
    assert.equal(asRecord(unknown.error)?.code, -32601);

    assert.deepEqual(mcp.unparsableLines(), [], 'stdout must carry only JSON-RPC lines');
    assert.equal(await mcp.close(), 0);
  } finally {
    mcp.kill();
  }
});

/* -------------------------------------------------------------- live host */

let liveHost: string | undefined;

before(async () => {
  // Read-only probe: does this machine have a reachable DSH host at all?
  try {
    liveHost = (await SessionClient.connect()).host;
  } catch {
    liveHost = undefined;
  }
});

test('dsh_sessions lists rows from the live host (read-only)', { timeout: 120_000 }, async (t) => {
  if (liveHost === undefined) {
    t.skip('no live DSH host reachable from this machine');
    return;
  }
  const env = childEnv({});
  delete env.DSH_BRIDGE_HOST;
  delete env.DSH_HOME;
  const mcp = new McpClient(env);
  try {
    await mcp.initialize();
    const payload = toolPayloadOf(await mcp.callTool('dsh_sessions', { limit: 3 }));
    assert.equal(payload.isError, undefined, String(payload.content[0]?.text));

    const rows = payload.structuredContent?.sessions;
    assert.ok(Array.isArray(rows), 'structuredContent.sessions must be an array');
    assert.ok(rows.length >= 1, 'the live host must list at least one session');
    const first = asRecord(rows[0]);
    assert.equal(typeof first?.sessionId, 'string');

    const text = String(payload.content[0]?.text);
    const lines = text.split('\n');
    assert.equal(lines.length, rows.length);
    for (const line of lines) {
      assert.equal(line.split('\t').length, 5, `plain row must have five fields: ${line}`);
    }
    assert.equal(lines[0]?.split('\t')[0], first?.sessionId);
    assert.deepEqual(mcp.unparsableLines(), []);
    assert.equal(await mcp.close(), 0);
  } finally {
    mcp.kill();
  }
});

/* --------------------------------------------------------------- staging */

let staging: Staging;

before(async () => {
  staging = await startStaging();
}, { timeout: 120_000 });

after(async () => {
  await staging?.stop();
}, { timeout: 30_000 });

function stagingMcp(): McpClient {
  return new McpClient(
    childEnv({ DSH_HOME: staging.home, DSH_BRIDGE_HOST: staging.url }),
  );
}

test('dsh_send completes against staging: text is the stub reply, status completed', { timeout: 120_000 }, async () => {
  staging.stub.setHandler((request): StubResponse => {
    if (request.lastHumanText.includes('mcp-marker')) return { text: 'MCP-PONG' };
    return { text: 'unexpected' };
  });
  const sessionId = await staging.createSession();
  const mcp = stagingMcp();
  try {
    await mcp.initialize();
    const payload = toolPayloadOf(
      await mcp.callTool('dsh_send', {
        target: { session: sessionId },
        text: 'mcp-marker',
        timeoutSeconds: 30,
      }),
    );
    assert.equal(payload.isError, undefined);
    assert.equal(payload.content.length, 1);
    assert.deepEqual(payload.content[0], { type: 'text', text: 'MCP-PONG' });

    const structured = payload.structuredContent;
    assert.ok(structured !== undefined);
    assert.equal(structured.status, 'completed');
    assert.equal(structured.text, 'MCP-PONG');
    assert.equal(structured.sessionId, sessionId);
    assert.equal(structured.from, 'mcp');
    assert.equal(typeof structured.rpcId, 'string');
    assert.deepEqual(structured.reason, { kind: 'completed' });
    assert.deepEqual(structured.usage, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 });

    // The prompt carried the MCP default prefix label.
    const call = staging.stub.agentCalls.find((request) =>
      request.lastHumanText.includes('mcp-marker'),
    );
    assert.equal(call?.lastHumanText, '[via mcp] mcp-marker');

    // Same rpcId read back through dsh_result: first without wait, then with.
    const readBack = toolPayloadOf(
      await mcp.callTool('dsh_result', { rpcId: structured.rpcId as string }),
    );
    assert.equal(readBack.isError, undefined);
    assert.equal(readBack.structuredContent?.status, 'completed');
    assert.equal(readBack.structuredContent?.text, 'MCP-PONG');
    assert.equal(readBack.content[0]?.text, 'MCP-PONG');

    assert.deepEqual(mcp.unparsableLines(), []);
    assert.equal(await mcp.close(), 0);
  } finally {
    mcp.kill();
  }
});

test('from defaults to $DSH_BRIDGE_FROM when the call omits it', { timeout: 120_000 }, async () => {
  staging.stub.setHandler((request): StubResponse => {
    if (request.lastHumanText.includes('env-from-marker')) return { text: 'ENV-FROM-OK' };
    return { text: 'unexpected' };
  });
  const sessionId = await staging.createSession();
  const mcp = new McpClient(
    childEnv({ DSH_HOME: staging.home, DSH_BRIDGE_HOST: staging.url, DSH_BRIDGE_FROM: 'ci-harness' }),
  );
  try {
    await mcp.initialize();
    const payload = toolPayloadOf(
      await mcp.callTool('dsh_send', {
        target: { session: sessionId },
        text: 'env-from-marker',
        timeoutSeconds: 30,
      }),
    );
    assert.equal(payload.isError, undefined);
    assert.equal(payload.structuredContent?.from, 'ci-harness');
    const call = staging.stub.agentCalls.find((request) =>
      request.lastHumanText.includes('env-from-marker'),
    );
    assert.equal(call?.lastHumanText, '[via ci-harness] env-from-marker');
    assert.equal(await mcp.close(), 0);
  } finally {
    mcp.kill();
  }
});

test('detach returns the rpcId as text; dsh_result --wait finishes the turn', { timeout: 120_000 }, async () => {
  staging.stub.setHandler((): StubResponse => ({ text: 'MCP-DETACHED', delayMs: 1500 }));
  const sessionId = await staging.createSession();
  const mcp = stagingMcp();
  try {
    await mcp.initialize();
    const started = Date.now();
    const detached = toolPayloadOf(
      await mcp.callTool('dsh_send', {
        target: { session: sessionId },
        text: 'mcp-detach-marker',
        detach: true,
        from: 'mcp-detach',
        timeoutSeconds: 30,
      }),
    );
    const elapsed = Date.now() - started;
    assert.equal(detached.isError, undefined);
    assert.equal(detached.structuredContent?.status, 'pending');
    const rpcId = detached.structuredContent?.rpcId as string;
    assert.match(rpcId, /^[0-9a-f-]{36}$/);
    assert.equal(detached.content[0]?.text, rpcId, 'a detached send returns the rpcId as text');
    assert.ok(elapsed < 1500, `detach must return before the turn ends (took ${String(elapsed)}ms)`);

    const waited = toolPayloadOf(
      await mcp.callTool('dsh_result', { rpcId, wait: true, timeoutSeconds: 20 }),
    );
    assert.equal(waited.isError, undefined, String(waited.content[0]?.text));
    assert.equal(waited.structuredContent?.status, 'completed');
    assert.equal(waited.structuredContent?.text, 'MCP-DETACHED');
    assert.equal(waited.structuredContent?.from, 'mcp-detach');
    assert.equal(waited.content[0]?.text, 'MCP-DETACHED');
    assert.equal(await mcp.close(), 0);
  } finally {
    mcp.kill();
  }
});

test('a timed-out send is isError with status timeout and stays readable', { timeout: 120_000 }, async () => {
  staging.stub.setHandler((): StubResponse => ({ text: 'LATE-BUT-DONE', delayMs: 3000 }));
  const sessionId = await staging.createSession();
  const mcp = stagingMcp();
  try {
    await mcp.initialize();
    const timedOut = toolPayloadOf(
      await mcp.callTool('dsh_send', {
        target: { session: sessionId },
        text: 'mcp-timeout-marker',
        timeoutSeconds: 1,
      }),
    );
    assert.equal(timedOut.isError, true);
    assert.equal(timedOut.structuredContent?.status, 'timeout');
    const rpcId = timedOut.structuredContent?.rpcId as string;
    assert.match(rpcId, /^[0-9a-f-]{36}$/);
    assert.match(String(timedOut.content[0]?.text), /timed out/);
    assert.ok(String(timedOut.content[0]?.text).includes(rpcId));

    // The documented recovery path: read the same rpcId back once the turn ends.
    const finished = toolPayloadOf(
      await mcp.callTool('dsh_result', { rpcId, wait: true, timeoutSeconds: 20 }),
    );
    assert.equal(finished.isError, undefined, String(finished.content[0]?.text));
    assert.equal(finished.structuredContent?.status, 'completed');
    assert.equal(finished.structuredContent?.text, 'LATE-BUT-DONE');

    const code = await mcp.close();
    assert.match(mcp.stderrText(), /timed out after 1s/);
    assert.equal(code, 0);
  } finally {
    mcp.kill();
  }
});

test('a bogus target is isError and the server keeps serving', { timeout: 120_000 }, async () => {
  staging.stub.setHandler((): StubResponse => ({ text: 'UNREACHABLE' }));
  const mcp = stagingMcp();
  try {
    await mcp.initialize();
    const failed = toolPayloadOf(
      await mcp.callTool('dsh_send', {
        target: { session: 'no-such-session-anywhere' },
        text: 'must not be sent',
        timeoutSeconds: 20,
      }),
    );
    assert.equal(failed.isError, true);
    assert.match(String(failed.content[0]?.text), /dsh_send: target/);
    assert.match(String(failed.content[0]?.text), /matched no sessions/);
    assert.equal(failed.structuredContent, undefined, 'a rejected send has no result object');

    // Nothing was prompted.
    assert.equal(
      staging.stub.agentCalls.filter((request) =>
        request.lastHumanText.includes('must not be sent'),
      ).length,
      0,
    );

    // Still serving after the failure.
    const sessions = toolPayloadOf(await mcp.callTool('dsh_sessions', { limit: 1 }));
    assert.equal(sessions.isError, undefined);
    assert.ok(Array.isArray(sessions.structuredContent?.sessions));

    // And a bad rpcId is a tool error too, not a transport error.
    const missing = toolPayloadOf(await mcp.callTool('dsh_result', { rpcId: 'not-a-real-rpc' }));
    assert.equal(missing.isError, true);
    assert.match(String(missing.content[0]?.text), /not in the send index/);

    assert.deepEqual(mcp.unparsableLines(), []);
    assert.equal(await mcp.close(), 0);
  } finally {
    mcp.kill();
  }
});
