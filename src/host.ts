/**
 * Host addressing, discovery, and the unary `/api` RPC helper (spec §3.2, §9).
 *
 * A host is identified by its origin. `RpcTransport` wraps exactly one
 * `client-request` envelope per call and turns every failure mode into a
 * message that names the host, endpoint, and HTTP status.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CredentialsError, HostError, ProtocolError, RpcError } from './errors.js';
import { loadBrowserSessionSecret, mintBrowserCookie } from './auth.js';
import { userInfo } from 'node:os';

/** Default unary-call budget. `session/list` on a busy host is fast. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** An addressed DSH Web origin. */
export class HostEndpoint {
  readonly url: URL;

  constructor(input: string) {
    const trimmed = input.trim();
    if (trimmed === '') throw new HostError('empty host; pass --host http://127.0.0.1:<port>');
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      throw new HostError(
        `invalid host "${input}"; expected a URL such as http://127.0.0.1:49904`,
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new HostError(`unsupported host protocol "${url.protocol}" in "${input}"`);
    }
    if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
      throw new HostError(`host "${input}" must be an origin (no path, query, or fragment)`);
    }
    this.url = url;
  }

  /** `host:port` exactly as addressed; feeds the cookie name and DSH's fence. */
  get authority(): string {
    return this.url.host;
  }

  /** `http(s)://host:port` with no trailing slash. */
  get origin(): string {
    return this.url.origin;
  }

  /** `ws(s)://host:port` for the mux carrier. */
  get wsOrigin(): string {
    return this.url.origin.replace(/^http/, 'ws');
  }

  toString(): string {
    return this.origin;
  }
}

interface ClientRequestEnvelope {
  type: 'client-request';
  rpcId: string;
  method: string;
  payload: { args: unknown };
}

interface ServerResponseEnvelope {
  type?: unknown;
  rpcId?: unknown;
  result?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One authenticated unary call. Every call mints a fresh local `rpcId` and
 * validates the server envelope instead of assuming it.
 */
export class RpcTransport {
  constructor(
    readonly endpoint: HostEndpoint,
    readonly cookie: string,
    readonly timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
  ) {}

  async call<T>(method: string, args: unknown): Promise<T> {
    const rpcId = randomUUID();
    const envelope: ClientRequestEnvelope = {
      type: 'client-request',
      rpcId,
      method,
      payload: { args },
    };

    let response: Response;
    try {
      response = await fetch(`${this.endpoint.origin}/api/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: this.cookie,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new HostError(
          `POST ${this.endpoint.origin}/api/${method} timed out after ${String(this.timeoutMs)} ms`,
          { cause: error },
        );
      }
      throw new HostError(
        `cannot reach DSH host ${this.endpoint.origin} (POST /api/${method}): ${String(error)}`,
        { cause: error },
      );
    }

    const raw = await response.text();
    if (!response.ok) {
      const snippet = raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
      if (response.status === 401) {
        throw new CredentialsError(
          `DSH host ${this.endpoint.origin} rejected the minted cookie (HTTP 401). ` +
            'The browser-session secret has rotated since DSH started; restart DSH and retry.',
        );
      }
      if (response.status === 403) {
        throw new CredentialsError(
          `DSH host ${this.endpoint.origin} rejected authority "${this.endpoint.authority}" ` +
            `(HTTP 403). The cookie was minted for a different host:port; use the exact ` +
            'loopback authority DSH is listening on.',
        );
      }
      if (response.status === 404) {
        throw new ProtocolError(
          `DSH host ${this.endpoint.origin} has no /api/${method} endpoint (HTTP 404). ` +
            'This DSH build may be incompatible with dsh-bridge.',
        );
      }
      throw new ProtocolError(
        `POST ${this.endpoint.origin}/api/${method} returned HTTP ${String(response.status)}: ${snippet}`,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ProtocolError(
        `POST ${this.endpoint.origin}/api/${method} returned non-JSON (HTTP ${String(response.status)}): ` +
          raw.slice(0, 400),
      );
    }
    return unwrapResponse<T>(body, method, rpcId, this.endpoint.origin);
  }
}

/** Validate a `server-response` envelope and return `result.value`. */
export function unwrapResponse<T>(
  body: unknown,
  method: string,
  rpcId: string,
  origin: string,
): T {
  if (!isRecord(body)) {
    throw new ProtocolError(
      `POST ${origin}/api/${method}: expected a JSON object envelope, got ${typeof body}`,
    );
  }
  const envelope = body as ServerResponseEnvelope;
  if (envelope.type !== 'server-response') {
    throw new ProtocolError(
      `POST ${origin}/api/${method}: expected envelope type "server-response", got ` +
        `${JSON.stringify(envelope.type)}`,
    );
  }
  if (envelope.rpcId !== rpcId) {
    throw new ProtocolError(
      `POST ${origin}/api/${method}: response rpcId ${JSON.stringify(envelope.rpcId)} does not ` +
        `match request rpcId ${rpcId}`,
    );
  }
  if (!isRecord(envelope.result)) {
    throw new ProtocolError(
      `POST ${origin}/api/${method}: response has no result object: ${JSON.stringify(body).slice(0, 400)}`,
    );
  }
  const result = envelope.result;
  if (result.ok !== true) {
    if (result.ok === false) {
      // Hosts in the wild put the error at result.error (0.1.x) or directly
      // on result (spec §3.2); accept both and never print "unknown".
      const nested = isRecord(result.error) ? result.error : undefined;
      const code =
        typeof result.code === 'string'
          ? result.code
          : typeof nested?.code === 'string'
            ? nested.code
            : 'unknown';
      const message =
        typeof result.message === 'string'
          ? result.message
          : typeof nested?.message === 'string'
            ? nested.message
            : '(no message)';
      throw new RpcError(method, code, message, result.details ?? nested?.details);
    }
    throw new ProtocolError(
      `POST ${origin}/api/${method}: result.ok must be true or false, got ` +
        `${JSON.stringify(result.ok)}`,
    );
  }
  return result.value as T;
}

export interface ResolvedHost {
  endpoint: HostEndpoint;
  cookie: string;
}

export interface ResolveHostOptions {
  /** `--host`, already higher priority than `DSH_BRIDGE_HOST`. */
  host?: string;
  dshHome: string;
  /** Optional diagnostic sink; discovery stays silent on success. */
  onDiscoveryNote?: (message: string) => void;
}

/**
 * Resolve the host in spec §9 order and mint its cookie:
 * `--host` → `DSH_BRIDGE_HOST` → loopback discovery confirmed by `session/list`.
 */
export async function resolveHost(options: ResolveHostOptions): Promise<ResolvedHost> {
  const secret = loadBrowserSessionSecret(options.dshHome);
  const explicit = options.host ?? process.env.DSH_BRIDGE_HOST;
  if (explicit !== undefined && explicit !== '') {
    const endpoint = new HostEndpoint(explicit);
    return { endpoint, cookie: mintBrowserCookie({ secret, authority: endpoint.authority }).header };
  }

  const candidates = discoverLoopbackCandidates();
  if (candidates.length === 0) {
    throw new HostError(
      'no loopback DSH host found. Start DSH Web (or the desktop app) and pass ' +
        '--host http://127.0.0.1:<port> if auto-detection cannot see it.',
    );
  }

  const failures: string[] = [];
  for (const endpoint of candidates) {
    const cookie = mintBrowserCookie({ secret, authority: endpoint.authority }).header;
    try {
      const transport = new RpcTransport(endpoint, cookie);
      await transport.call<{ items?: unknown[] }>('session/list', { _request: {} });
      return { endpoint, cookie };
    } catch (error) {
      failures.push(`${endpoint.origin}: ${(error as Error).message.split('\n')[0] ?? ''}`);
      options.onDiscoveryNote?.(
        `host discovery: ${endpoint.origin} did not confirm (${(error as Error).name})`,
      );
    }
  }

  throw new HostError(
    `no reachable DSH host among loopback candidates.\n  ${failures.join('\n  ')}\n` +
      'Pass --host http://127.0.0.1:<port> explicitly, and --dsh-home if that host uses a ' +
      'different DSH home.',
  );
}

/**
 * macOS: enumerate listening loopback TCP sockets owned by this user, keep
 * processes whose command line mentions DeepSeek Harness or dsh.
 */
export function discoverLoopbackCandidates(): HostEndpoint[] {
  if (process.platform !== 'darwin') {
    throw new HostError(
      'automatic host discovery uses macOS lsof; pass --host http://127.0.0.1:<port> ' +
        `on ${process.platform}`,
    );
  }
  const uid = userInfo().uid;
  let output: string;
  try {
    output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-u', String(uid), '-a'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    });
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim() !== '') {
      output = stdout;
    } else {
      throw new HostError(
        `cannot enumerate listening sockets with lsof: ${String(error)}. ` +
          'Pass --host http://127.0.0.1:<port> explicitly.',
      );
    }
  }

  const sockets = parseLsofListeners(output);
  if (sockets.size === 0) return [];

  const pids = [...new Set([...sockets.values()].map((socket) => socket.pid))];
  const commands = readProcessCommands(pids);
  const candidates: { endpoint: HostEndpoint; score: number }[] = [];
  for (const [port, socket] of sockets) {
    const command = commands.get(socket.pid) ?? socket.command;
    if (!/\bDeepSeek Harness\b|\bdsh\b/i.test(command)) continue;
    const score = /\bDeepSeek Harness\b/i.test(command) ? 0 : 1;
    try {
      candidates.push({ endpoint: new HostEndpoint(`http://127.0.0.1:${String(port)}`), score });
    } catch {
      // A non-TCP-shaped NAME slipped through the parser; skip it.
    }
  }
  candidates.sort((left, right) => left.score - right.score || compareEndpoint(left.endpoint, right.endpoint));
  return candidates.map((candidate) => candidate.endpoint);
}

interface ListeningSocket {
  pid: number;
  command: string;
}

/** Parse the NAME/PID columns of `lsof -nP -iTCP -sTCP:LISTEN`. */
export function parseLsofListeners(output: string): Map<number, ListeningSocket> {
  const sockets = new Map<number, ListeningSocket>();
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9 || fields[0] === 'COMMAND') continue;
    const pid = Number(fields[1]);
    const tcpName = /TCP\s+(\S+?)(?:\s+\(LISTEN\))?\s*$/.exec(line);
    const name = tcpName?.[1] ?? '';
    const match = /^(?:127\.0\.0\.1|\[::1\]):(\d+)$/.exec(name);
    if (!Number.isSafeInteger(pid) || match === null) continue;
    const port = Number(match[1]);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) continue;
    if (!sockets.has(port)) {
      sockets.set(port, { pid, command: fields[0] ?? '' });
    }
  }
  return sockets;
}

function readProcessCommands(pids: number[]): Map<number, string> {
  const commands = new Map<number, string>();
  if (pids.length === 0) return commands;
  try {
    const output = execFileSync('ps', ['-p', pids.join(','), '-o', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match !== null) commands.set(Number(match[1]), match[2] ?? '');
    }
  } catch {
    // ps is best-effort; the lsof COMMAND column remains as a fallback.
  }
  return commands;
}

function compareEndpoint(left: HostEndpoint, right: HostEndpoint): number {
  return left.url.port.localeCompare(right.url.port, undefined, { numeric: true });
}
