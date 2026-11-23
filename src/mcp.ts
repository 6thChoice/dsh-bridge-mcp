#!/usr/bin/env node
/**
 * `dsh-bridge-mcp` — MCP stdio shell over the T1 core (spec §10).
 *
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout, exactly three tools. This
 * file is a shell: every behaviour that touches DSH (auth, discovery, resolve,
 * prompt/await, read-back) is delegated to the same modules the CLI uses, so
 * the two front ends cannot drift.
 *
 * stdout carries protocol frames only. Every diagnostic — discovery notes,
 * timeout hints, unexpected failures — goes to stderr.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type SessionRow,
  asRecord,
  SessionClient,
  sessionCwd,
  sessionTitle,
  sessionUpdatedAt,
} from './client.js';
import { BridgeError } from './errors.js';
import { filterSessions, hasSelector, type Target } from './resolve.js';
import { SendIndex, resultMessage } from './result.js';
import { type SendOutcome, sendMessage } from './run.js';
import { isNodeVersionSupported, nodeVersionMessage } from './runtime.js';

export const SERVER_NAME = 'dsh-bridge';

/** Protocol version this shell implements (MCP 2024-11-05 feature set). */
export const LATEST_PROTOCOL_VERSION = '2024-11-05';

/**
 * Versions whose framing we speak. The tool surface is identical across them;
 * `initialize` echoes the client's version when it is in this set and answers
 * with `LATEST_PROTOCOL_VERSION` otherwise (spec §10).
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
];

/** Spec §10: MCP calls wait 3600 s unless the caller passes `timeoutSeconds`. */
export const DEFAULT_MCP_TIMEOUT_SECONDS = 3600;

/** `from` default when neither the call nor `$DSH_BRIDGE_FROM` supplies one. */
export const DEFAULT_MCP_FROM = 'mcp';

const JSONRPC_VERSION = '2.0';

/* JSON-RPC 2.0 error codes. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/**
 * Version from the package manifest. `dist/mcp.js` finds `../package.json`
 * directly; importing `src/mcp.ts` from a build tree needs one more level.
 */
function readServerVersion(): string {
  for (const relative of ['../package.json', '../../package.json']) {
    try {
      const raw = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      const parsed = asRecord(JSON.parse(raw) as unknown);
      // Accept the historical package name too: `src/mcp.ts` in a build tree
      // may resolve the manifest before the release rename lands.
      if (
        (parsed?.name === 'dsh-bridge-mcp' || parsed?.name === 'dsh-bridge') &&
        typeof parsed.version === 'string'
      ) {
        return parsed.version;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return '0.0.0';
}

export const SERVER_VERSION = readServerVersion();

/* ------------------------------------------------------------------ schemas */

export type JsonSchema = Record<string, unknown>;

const TARGET_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    'Which existing session to address. Filters AND together; everything absent means no filter, ' +
    'which is rejected by dsh_send (never guess a target).',
  properties: {
    session: {
      type: 'string',
      description: 'Exact session id or a unique prefix; a leading "session-" is ignored.',
    },
    title: { type: 'string', description: 'Case-insensitive substring of the session title.' },
    cwd: {
      type: 'string',
      description: 'Exact working directory of the session (realpath-normalized).',
    },
    latest: {
      type: 'boolean',
      description: 'Take the newest updatedAt among the rows matching the other filters.',
    },
  },
  additionalProperties: false,
};

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'dsh_send',
    description:
      'Send one message to an existing DeepSeek Harness session and wait for that message\'s own ' +
      'turn to end. Returns the turn\'s final assistant text, plus the full result object as ' +
      'structuredContent (rpcId, sessionId, status, reason, toolCalls, usage, host). Use ' +
      'detach=true to return immediately with status "pending", then dsh_result to read it back. ' +
      'This is the only tool that prompts a session.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET_SCHEMA,
        text: { type: 'string', description: 'The message to send (plain text).' },
        from: {
          type: 'string',
          description:
            'Label put in the "[via <from>] " prefix and recorded in the send index; defaults to ' +
            'the DSH_BRIDGE_FROM environment variable or "mcp".',
        },
        timeoutSeconds: {
          type: 'number',
          description:
            'How long to wait for the turn to end before returning status "timeout"; default 3600.',
        },
        detach: {
          type: 'boolean',
          description:
            'Return as soon as the prompt is accepted (status "pending", text is the rpcId) ' +
            'instead of waiting for the turn to end. Default false.',
        },
        prefix: {
          type: 'boolean',
          description:
            'Prepend "[via <from>] " to the text. Default true; set false to send the text verbatim.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_result',
    description:
      'Read back the outcome of a message previously accepted by dsh_send, without sending ' +
      'anything new. Returns the same object shape as dsh_send. Use wait=true to block until ' +
      'the turn ends instead of returning status "pending".',
    inputSchema: {
      type: 'object',
      properties: {
        rpcId: {
          type: 'string',
          description: 'The rpcId returned by dsh_send (structuredContent.rpcId).',
        },
        wait: {
          type: 'boolean',
          description:
            'Wait for the turn to end instead of returning status "pending" immediately. ' +
            'Default false.',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'How long wait=true may block before returning status "timeout"; default 3600.',
        },
      },
      required: ['rpcId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_sessions',
    description:
      'List DeepSeek Harness sessions (read-only; also the connectivity/auth self-check). Use it ' +
      'to discover a session id for dsh_send. Filters AND together; no filter lists everything. ' +
      'Each row is the raw session/list record and therefore verbose, so pass a small limit.',
    inputSchema: {
      type: 'object',
      properties: {
        session: {
          type: 'string',
          description: 'Exact session id or a unique prefix; a leading "session-" is ignored.',
        },
        title: { type: 'string', description: 'Case-insensitive substring of the session title.' },
        cwd: {
          type: 'string',
          description: 'Exact working directory of the session (realpath-normalized).',
        },
        latest: {
          type: 'boolean',
          description: 'Keep only the newest updatedAt among the rows matching the other filters.',
        },
        limit: {
          type: 'integer',
          description: 'Return at most this many rows (newest first).',
        },
      },
      additionalProperties: false,
    },
  },
];

/* --------------------------------------------------------------- JSON-RPC IO */

export type JsonRpcId = string | number | null;

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: Record<string, unknown>;
}

export interface RpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: RpcErrorObject;
}

export type RpcResponse = RpcSuccess | RpcFailure;

function success(id: JsonRpcId, result: Record<string, unknown>): RpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function failure(id: JsonRpcId, code: number, message: string, data?: unknown): RpcFailure {
  const error: RpcErrorObject = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

function idOf(message: unknown): JsonRpcId {
  const record = asRecord(message);
  if (record === undefined || !('id' in record)) return null;
  const id = record.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/** A request without an `id` member is a notification: no response, ever. */
function isNotification(message: Record<string, unknown>): boolean {
  return !('id' in message);
}

/* ------------------------------------------------------------ tool dispatch */

/** Bad arguments for a known tool: reported as `isError: true`, not a transport error. */
class ToolInputError extends Error {}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolCallPayload {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function textContent(text: string): TextContent {
  return { type: 'text', text };
}

function toolError(message: string): ToolCallPayload {
  return { content: [textContent(message)], isError: true };
}

function optionalStringField(
  source: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolInputError(`${where}.${key} must be a string`);
  return value;
}

function optionalBooleanField(
  source: Record<string, unknown>,
  key: string,
  where: string,
): boolean | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ToolInputError(`${where}.${key} must be a boolean`);
  return value;
}

function timeoutMsFor(source: Record<string, unknown>, where: string): number {
  const raw = source.timeoutSeconds;
  if (raw === undefined || raw === null) return DEFAULT_MCP_TIMEOUT_SECONDS * 1000;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new ToolInputError(`${where}.timeoutSeconds must be a positive number of seconds`);
  }
  return Math.round(raw * 1000);
}

function limitFor(source: Record<string, unknown>, where: string): number | undefined {
  const raw = source.limit;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new ToolInputError(`${where}.limit must be a positive integer`);
  }
  return raw;
}

/** Read `{session?,title?,cwd?,latest?}` (nested for dsh_send, flat for dsh_sessions). */
function readTarget(source: Record<string, unknown>, where: string): Target {
  const target: Target = {};
  const session = optionalStringField(source, 'session', where);
  const title = optionalStringField(source, 'title', where);
  const cwd = optionalStringField(source, 'cwd', where);
  const latest = optionalBooleanField(source, 'latest', where);
  if (session !== undefined) target.session = session;
  if (title !== undefined) target.title = title;
  if (cwd !== undefined) target.cwd = cwd;
  if (latest === true) target.latest = true;
  return target;
}

function nestedTarget(args: Record<string, unknown>): Target {
  const raw = args.target;
  if (raw === undefined || raw === null) return {};
  const record = asRecord(raw);
  if (record === undefined) throw new ToolInputError('arguments.target must be an object');
  return readTarget(record, 'target');
}

function connectClient(): Promise<SessionClient> {
  return SessionClient.connect({
    caller: 'mcp',
    onDiscoveryNote: (message: string) => {
      writeDiagnostic(message);
    },
  });
}

/** One `send` through T1's engine; same semantics as `dsh-bridge send`. */
async function callSend(args: Record<string, unknown>): Promise<ToolCallPayload> {
  const text = optionalStringField(args, 'text', 'arguments');
  if (text === undefined) {
    throw new ToolInputError('arguments.text is required and must be a string');
  }
  if (text.trim() === '') throw new ToolInputError('arguments.text must not be empty');

  const from = optionalStringField(args, 'from', 'arguments') ?? process.env.DSH_BRIDGE_FROM ?? DEFAULT_MCP_FROM;
  if (from.trim() === '') throw new ToolInputError('arguments.from must not be empty');
  if (/[\r\n]/.test(from)) throw new ToolInputError('arguments.from must not contain newlines');

  const target = nestedTarget(args);
  if (!hasSelector(target)) {
    throw new ToolInputError(
      'dsh_send needs a target: pass target.session, target.title, target.cwd, or target.latest',
    );
  }

  const client = await connectClient();
  const outcome = await sendMessage({
    client,
    target,
    text,
    from,
    prefix: optionalBooleanField(args, 'prefix', 'arguments') ?? true,
    mode: 'queue',
    timeoutMs: timeoutMsFor(args, 'arguments'),
    detach: optionalBooleanField(args, 'detach', 'arguments') ?? false,
    index: new SendIndex(client.dshHome),
  });
  return outcomePayload(outcome);
}

/** One `result` read-back; same semantics as `dsh-bridge result`. */
async function callResult(args: Record<string, unknown>): Promise<ToolCallPayload> {
  const rpcId = optionalStringField(args, 'rpcId', 'arguments');
  if (rpcId === undefined || rpcId.trim() === '') {
    throw new ToolInputError('arguments.rpcId is required and must be a non-empty string');
  }
  const client = await connectClient();
  const outcome = await resultMessage({
    client,
    index: new SendIndex(client.dshHome),
    rpcId,
    wait: optionalBooleanField(args, 'wait', 'arguments') ?? false,
    timeoutMs: timeoutMsFor(args, 'arguments'),
  });
  return outcomePayload(outcome);
}

function rowLine(row: SessionRow): string {
  // Spec §8 plain row shape; kept byte-identical to the CLI's `sessions` output.
  const updatedAt = typeof row.updatedAt === 'number' ? new Date(row.updatedAt).toISOString() : '';
  return [
    row.sessionId,
    String(row.running === true),
    updatedAt,
    sessionTitle(row),
    sessionCwd(row) ?? '',
  ].join('\t');
}

/** One `sessions` listing (read-only). */
async function callSessions(args: Record<string, unknown>): Promise<ToolCallPayload> {
  const target = readTarget(args, 'arguments');
  const limit = limitFor(args, 'arguments');
  const client = await connectClient();
  const rows = await client.listSessions();
  let filtered = filterSessions(rows, target).sort(
    (left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left),
  );
  if (limit !== undefined) filtered = filtered.slice(0, limit);
  return {
    content: [textContent(filtered.map(rowLine).join('\n'))],
    structuredContent: { sessions: filtered },
  };
}

/**
 * §6 (§10) payload for a send/result outcome.
 *
 * The text block follows §6's plain rendering: the turn's assistant text, or
 * the rpcId while the turn is pending, or the status line when the call failed
 * with no text. `structuredContent` is always the full result object.
 * `isError` mirrors the CLI exit code (2 = timeout, 3 = error/cancelled), so a
 * client that never looks at structuredContent cannot read a failed turn as
 * success.
 */
function outcomePayload(outcome: SendOutcome): ToolCallPayload {
  const result = outcome.result;
  const isError = outcome.exitCode !== 0;
  let text = result.text;
  if (text === '' && result.status === 'pending') {
    text = result.rpcId;
  } else if (text === '' && isError) {
    const kind = JSON.stringify(result.reason.kind ?? 'unknown');
    text =
      outcome.timeoutHint ??
      `status=${result.status} (reason kind ${kind}), rpcId ${result.rpcId}`;
  }
  if (outcome.timeoutHint !== undefined) writeDiagnostic(outcome.timeoutHint);

  const payload: ToolCallPayload = {
    content: [textContent(text)],
    structuredContent: { ...result },
  };
  if (isError) payload.isError = true;
  return payload;
}

const TOOL_HANDLERS: Readonly<
  Record<string, (args: Record<string, unknown>) => Promise<ToolCallPayload>>
> = {
  dsh_send: callSend,
  dsh_result: callResult,
  dsh_sessions: callSessions,
};

export function toolNames(): string[] {
  return TOOLS.map((tool) => tool.name);
}

/* ------------------------------------------------------------- method table */

export function protocolVersionFor(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

function initializeResult(params: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    protocolVersion: protocolVersionFor(params?.protocolVersion),
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions:
      'dsh-bridge hands one message to an existing DeepSeek Harness session. Use dsh_sessions to ' +
      'find a session id, dsh_send to prompt it (waiting for its own turn), dsh_result to read a ' +
      'detached send back. Host and DSH home come from DSH_BRIDGE_HOST / DSH_HOME, the optional ' +
      'dsh-bridge config file, or platform discovery.',
  };
}

async function callTool(params: unknown): Promise<ToolCallPayload | RpcFailure> {
  const record = asRecord(params);
  if (record === undefined) {
    return failure(null, INVALID_PARAMS, 'tools/call params must be an object with a tool name');
  }
  const name = record.name;
  if (typeof name !== 'string' || name === '') {
    return failure(null, INVALID_PARAMS, 'tools/call params.name must be a non-empty string');
  }
  const handler = TOOL_HANDLERS[name];
  if (handler === undefined) {
    return failure(
      null,
      INVALID_PARAMS,
      `unknown tool ${JSON.stringify(name)}; this server exposes ${toolNames().join(', ')}`,
    );
  }
  let args: Record<string, unknown> = {};
  if (record.arguments !== undefined && record.arguments !== null) {
    const parsed = asRecord(record.arguments);
    if (parsed === undefined) {
      return failure(null, INVALID_PARAMS, 'tools/call params.arguments must be an object');
    }
    args = parsed;
  }
  try {
    return await handler(args);
  } catch (error) {
    if (error instanceof ToolInputError) return toolError(`${name}: ${error.message}`);
    if (error instanceof BridgeError) {
      writeDiagnostic(`${name} failed: ${error.message}`);
      return toolError(`${name}: ${error.message}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    writeDiagnostic(`${name} crashed: ${error instanceof Error && error.stack !== undefined ? error.stack : message}`);
    return toolError(`${name}: unexpected failure: ${message}`);
  }
}

/**
 * Handle one decoded JSON-RPC message.
 *
 * Returns `null` for notifications (no response is permitted) and a response
 * object otherwise. Tool-level failures are `isError` content results; only
 * framing problems become JSON-RPC errors.
 */
export async function handleRequest(message: unknown): Promise<RpcResponse | null> {
  if (Array.isArray(message)) {
    return failure(null, INVALID_REQUEST, 'JSON-RPC batches are not supported; send one message per line');
  }
  const record = asRecord(message);
  if (record === undefined) {
    return failure(null, INVALID_REQUEST, 'each line must be a JSON object (JSON-RPC 2.0 message)');
  }
  const id = idOf(record);
  if (record.jsonrpc !== JSONRPC_VERSION) {
    return failure(
      id,
      INVALID_REQUEST,
      `expected jsonrpc "${JSONRPC_VERSION}", got ${JSON.stringify(record.jsonrpc)}`,
    );
  }
  const method = record.method;
  if (typeof method !== 'string' || method === '') {
    return failure(id, INVALID_REQUEST, 'message.method must be a non-empty string');
  }

  if (isNotification(record)) {
    // `notifications/initialized`, `notifications/cancelled`, …: nothing to do.
    return null;
  }
  const params = asRecord(record.params);

  switch (method) {
    case 'initialize':
      return success(id, initializeResult(params));
    case 'ping':
      return success(id, {});
    case 'tools/list':
      return success(id, { tools: TOOLS });
    case 'tools/call': {
      const payload = await callTool(record.params);
      return 'jsonrpc' in payload ? { ...payload, id } : success(id, { ...payload });
    }
    default:
      return failure(
        id,
        METHOD_NOT_FOUND,
        `unknown method ${JSON.stringify(method)}; supported: initialize, ping, tools/list, tools/call`,
      );
  }
}

/* -------------------------------------------------------------------- stdio */

let stdoutBroken = false;

function writeDiagnostic(message: string): void {
  process.stderr.write(`dsh-bridge-mcp: ${message}\n`);
}

function writeResponse(response: RpcResponse): void {
  if (stdoutBroken) return;
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

/** Run the stdio server until stdin ends (or the client closes the pipe). */
export async function main(): Promise<number> {
  if (!isNodeVersionSupported()) {
    process.stderr.write(`${nodeVersionMessage()}\n`);
    return 1;
  }

  process.stdout.on('error', (error: Error) => {
    stdoutBroken = true;
    writeDiagnostic(`stdout is closed (${error.message}); stopping`);
    process.exitCode = 0;
  });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set<Promise<void>>();

  const dispatch = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeDiagnostic(`dropping a stdin line that is not JSON: ${detail}`);
      writeResponse(failure(null, PARSE_ERROR, `cannot parse JSON-RPC message: ${detail}`));
      return;
    }
    const job = handleRequest(message)
      .then((response) => {
        if (response !== null) writeResponse(response);
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        writeDiagnostic(`internal error: ${detail}`);
        writeResponse(failure(idOf(message), INTERNAL_ERROR, `internal error: ${detail}`));
      });
    inFlight.add(job);
    void job.then(() => {
      inFlight.delete(job);
    });
  };

  for await (const line of lines) dispatch(line);
  // A client that closes stdin may still be reading our last responses.
  await Promise.allSettled([...inFlight]);
  return 0;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // `npm link` runs the bin through a symlink; compare real paths.
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main();
}
