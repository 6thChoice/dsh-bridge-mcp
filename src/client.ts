/**
 * DSH session client: unary calls plus the `session/follow` WebSocket carrier
 * (spec §3.2–§3.5). Only settled durable events are exposed; assistant-stream
 * frames are dropped because v1 never returns partial output.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostEndpoint, RpcTransport, resolveHost, type CallerKind, type HostSource } from './host.js';
import { ProtocolError } from './errors.js';
import { resolveDshHome } from './config.js';

/** Default follow-opening budget. */
export const DEFAULT_FOLLOW_TIMEOUT_MS = 15_000;

export interface SessionRow {
  sessionId: string;
  updatedAt?: number;
  running?: boolean;
  agentAvailable?: boolean;
  blank?: boolean;
  cwd?: string;
  projections?: {
    values?: Record<string, unknown>;
    asOfSeq?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface DurableEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
}

export interface StreamRecord {
  type: string;
  event?: DurableEvent;
  [key: string]: unknown;
}

export interface SessionPage {
  records: StreamRecord[];
  hasMore: boolean;
}

export interface Snapshot {
  cursor: number;
  records: StreamRecord[];
}

export interface PromptRequest {
  sessionId: string;
  requestId: string;
  mode: 'queue' | 'steer';
  text: string;
}

export interface SessionClientOptions {
  /** Explicit host URL; falls back to `DSH_BRIDGE_HOST`, the config file, then discovery. */
  host?: string;
  /** DSH home used for `.credentials.yaml`; defaults to `$DSH_HOME`, config, then `~/.dsh`. */
  dshHome?: string;
  /** Front end asking (`cli` or `mcp`); only host-discovery error hints differ. */
  caller?: CallerKind;
  rpcTimeoutMs?: number;
  onDiscoveryNote?: (message: string) => void;
}

/** Default DSH home without consulting the config file (kept for API compatibility). */
export function defaultDshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv !== undefined && fromEnv !== ''
    ? resolveDshHome({ flag: fromEnv })
    : join(homedir(), '.dsh');
}

/** Session title as projected by `session/list`; empty string when absent. */
export function sessionTitle(row: SessionRow): string {
  const title = row.projections?.values?.title;
  return typeof title === 'string' ? title : '';
}

/** Session working directory as listed, when present. */
export function sessionCwd(row: SessionRow): string | undefined {
  return typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : undefined;
}

/** Current durable cursor as projected by `session/list`, when present. */
export function sessionCursor(row: SessionRow): number | undefined {
  const cursor = row.projections?.asOfSeq;
  return typeof cursor === 'number' && Number.isSafeInteger(cursor) ? cursor : undefined;
}

export function sessionUpdatedAt(row: SessionRow): number {
  return typeof row.updatedAt === 'number' ? row.updatedAt : 0;
}

export class SessionClient {
  readonly endpoint: HostEndpoint;
  readonly cookie: string;
  /** DSH home actually resolved for this client (config-aware). */
  readonly dshHome: string;
  /** Where the host came from (`flag`, `env`, `config-*`, `discovery`). */
  readonly hostSource: HostSource | undefined;
  private readonly transport: RpcTransport;

  constructor(
    endpoint: HostEndpoint,
    cookie: string,
    options: { rpcTimeoutMs?: number; dshHome?: string; hostSource?: HostSource } = {},
  ) {
    this.endpoint = endpoint;
    this.cookie = cookie;
    this.dshHome = options.dshHome ?? defaultDshHome();
    this.hostSource = options.hostSource;
    this.transport = new RpcTransport(endpoint, cookie, options.rpcTimeoutMs);
  }

  /**
   * Resolve host + credentials and return a client. Throws before any traffic
   * when credentials are missing; auto-discovery confirms with `session/list`.
   */
  static async connect(options: SessionClientOptions = {}): Promise<SessionClient> {
    const resolved = await resolveHost(options);
    return new SessionClient(resolved.endpoint, resolved.cookie, {
      dshHome: resolved.dshHome,
      hostSource: resolved.source,
      ...(options.rpcTimeoutMs === undefined ? {} : { rpcTimeoutMs: options.rpcTimeoutMs }),
    });
  }

  get host(): string {
    return this.endpoint.origin;
  }

  async rpc<T>(method: string, args: unknown): Promise<T> {
    return this.transport.call<T>(method, args);
  }

  async listSessions(): Promise<SessionRow[]> {
    const value = await this.rpc<unknown>('session/list', { _request: {} });
    const record = asRecord(value);
    const items = record?.items;
    if (!Array.isArray(items)) {
      throw new ProtocolError(
        `session/list from ${this.host} returned no items array: ${JSON.stringify(value).slice(0, 400)}`,
      );
    }
    return items.map((item, index) => {
      const row = asRecord(item);
      if (row === undefined || typeof row.sessionId !== 'string' || row.sessionId === '') {
        throw new ProtocolError(
          `session/list from ${this.host} returned an item without sessionId at index ${String(index)}`,
        );
      }
      return row as SessionRow;
    });
  }

  async pageSession(
    sessionId: string,
    throughSeq: number,
    maxMessages: number,
  ): Promise<SessionPage> {
    const value = await this.rpc<unknown>('session/page', {
      request: {
        address: { kind: 'session', sessionId },
        throughSeq,
        maxMessages,
      },
    });
    const record = asRecord(value);
    const records = record?.records;
    if (!Array.isArray(records)) {
      throw new ProtocolError(
        `session/page from ${this.host} returned no records array: ${JSON.stringify(value).slice(0, 400)}`,
      );
    }
    return { records: records as StreamRecord[], hasMore: record?.hasMore === true };
  }

  async prompt(request: PromptRequest): Promise<void> {
    const value = await this.rpc<unknown>('session/prompt', {
      request: {
        requestId: request.requestId,
        sessionId: request.sessionId,
        mode: request.mode,
        content: [{ type: 'text', text: request.text }],
      },
    });
    const record = asRecord(value);
    if (record?.accepted !== true) {
      throw new ProtocolError(
        `session/prompt to ${this.host} was not accepted: ${JSON.stringify(value).slice(0, 400)}`,
      );
    }
  }

  /** Open `session/follow` and wait for the opening snapshot. */
  async followSession(sessionId: string, timeoutMs?: number): Promise<FollowStream> {
    return FollowStream.open({
      endpoint: this.endpoint,
      cookie: this.cookie,
      sessionId,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }
}

export interface FollowOpenOptions {
  endpoint: HostEndpoint;
  cookie: string;
  sessionId: string;
  timeoutMs?: number;
}

/**
 * One `session/follow` stream. The opening snapshot (cursor + records) is
 * captured before `session/prompt`, which gives `send` its baseline cursor.
 */
export class FollowStream {
  readonly snapshot: Snapshot;
  private readonly socket: WebSocket;
  private readonly queue: DurableEvent[] = [];
  private waiter: {
    resolve: (event: DurableEvent | null) => void;
    reject: (error: Error) => void;
  } | null = null;
  private ended = false;
  private failure: Error | null = null;
  private closeRequested = false;

  private constructor(socket: WebSocket, snapshot: Snapshot) {
    this.socket = socket;
    this.snapshot = snapshot;
  }

  static async open(options: FollowOpenOptions): Promise<FollowStream> {
    const streamId = `dsh-bridge-${randomUUID()}`;
    const url = `${options.endpoint.wsOrigin}/api/remote.mux`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { headers: { cookie: options.cookie } });
    } catch (error) {
      throw new ProtocolError(
        `cannot open ${url}: ${String(error)}. Node >=22.19 exposes a global WebSocket; ` +
          'this runtime rejected it.',
        { cause: error },
      );
    }

    let stream: FollowStream | null = null;
    let readyResolve!: (snapshot: Snapshot) => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<Snapshot>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    let settled = false;

    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        readyReject(error);
        return;
      }
      stream?.fail(error);
    };

    const timer = setTimeout(() => {
      fail(
        new ProtocolError(
          `session/follow on ${options.endpoint.origin} did not publish an opening snapshot ` +
            `within ${String(options.timeoutMs ?? DEFAULT_FOLLOW_TIMEOUT_MS)} ms`,
        ),
      );
      socket.close();
    }, options.timeoutMs ?? DEFAULT_FOLLOW_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'open',
          streamId,
          endpoint: 'session/follow',
          payload: {
            args: { request: { address: { kind: 'session', sessionId: options.sessionId } } },
          },
        }),
      );
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      const text = event.data;
      if (typeof text !== 'string') {
        fail(new ProtocolError(`session/follow on ${options.endpoint.origin} sent a non-text frame`));
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        fail(
          new ProtocolError(
            `session/follow on ${options.endpoint.origin} sent non-JSON: ${text.slice(0, 200)}`,
          ),
        );
        return;
      }
      if (!isRecord(frame)) {
        fail(
          new ProtocolError(`session/follow on ${options.endpoint.origin} sent a non-object frame`),
        );
        return;
      }
      if (frame.streamId !== streamId) return;
      try {
        if (frame.type === 'item') {
          const value = asRecord(frame.value);
          if (value?.type === 'snapshot') {
            if (settled) {
              fail(new ProtocolError('session/follow published a second opening snapshot'));
              return;
            }
            const cursor = value.cursor;
            if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor)) {
              throw new ProtocolError(
                `session/follow snapshot from ${options.endpoint.origin} has no integer cursor`,
              );
            }
            if (!Array.isArray(value.records)) {
              throw new ProtocolError(
                `session/follow snapshot from ${options.endpoint.origin} has no records array`,
              );
            }
            settled = true;
            clearTimeout(timer);
            stream = new FollowStream(socket, {
              cursor,
              records: value.records as StreamRecord[],
            });
            readyResolve(stream.snapshot);
            return;
          }
          if (value?.type === 'assistant-stream') return;
          if (value?.type === 'event') {
            if (!settled) return;
            stream?.push(parseDurableEvent(value.event, options.endpoint.origin));
          }
          return;
        }
        if (frame.type === 'end') {
          if (!settled) {
            fail(
              new ProtocolError(
                `session/follow on ${options.endpoint.origin} ended before its opening snapshot`,
              ),
            );
          } else {
            stream?.finish();
          }
          return;
        }
        if (frame.type === 'error') {
          const message = JSON.stringify(frame.error ?? frame.value ?? frame);
          fail(
            new ProtocolError(
              `session/follow on ${options.endpoint.origin} failed: ${message}`,
            ),
          );
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.addEventListener('error', () => {
      fail(
        new ProtocolError(
          `session/follow WebSocket to ${options.endpoint.origin} failed ` +
            '(check the cookie/authority; `sessions` is the connectivity self-check)',
        ),
      );
    });

    socket.addEventListener('close', (event: { code: number }) => {
      if (!settled) {
        fail(
          new ProtocolError(
            `session/follow to ${options.endpoint.origin} closed before its snapshot ` +
              `(code ${String(event.code)})`,
          ),
        );
        return;
      }
      stream?.closeFromServer(event.code);
    });

    await ready;
    if (stream === null) {
      throw new ProtocolError(`session/follow on ${options.endpoint.origin} produced no stream`);
    }
    return stream;
  }

  private push(event: DurableEvent): void {
    if (this.ended) return;
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(event);
      return;
    }
    this.queue.push(event);
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(null);
    }
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }

  private closeFromServer(code: number): void {
    if (this.closeRequested) {
      this.finish();
      return;
    }
    this.fail(
      new ProtocolError(
        `session/follow stream closed unexpectedly (code ${String(code)}) before turn/end`,
      ),
    );
  }

  /** Durable events after the opening snapshot, in arrival order. */
  async *events(): AsyncIterable<DurableEvent> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.failure !== null) throw this.failure;
      if (this.ended) return;
      const next = await new Promise<DurableEvent | null>((resolve, reject) => {
        this.waiter = { resolve, reject };
      });
      if (next === null) return;
      yield next;
    }
  }

  /** Durable events in the opening snapshot, in seq order. */
  snapshotEvents(): DurableEvent[] {
    const events: DurableEvent[] = [];
    for (const record of this.snapshot.records) {
      if (record.type !== 'event') continue;
      const event = asRecord(record.event);
      if (event === undefined) continue;
      try {
        events.push(parseDurableEvent(event, 'snapshot'));
      } catch {
        // Unknown snapshot record shapes are not part of the contract we use.
      }
    }
    events.sort((left, right) => left.seq - right.seq);
    return events;
  }

  close(): void {
    this.closeRequested = true;
    this.finish();
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

/** `session/list` rows have `session-` on some hosts and not others. */
export function stripSessionPrefix(sessionId: string): string {
  return sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== undefined;
}

/** Validate one `{type,seq,time,data}` durable event. */
export function parseDurableEvent(value: unknown, origin: string): DurableEvent {
  const event = asRecord(value);
  if (
    event === undefined ||
    typeof event.type !== 'string' ||
    typeof event.seq !== 'number' ||
    typeof event.time !== 'number'
  ) {
    throw new ProtocolError(
      `malformed durable event from ${origin}: ${JSON.stringify(value).slice(0, 300)}`,
    );
  }
  const data = asRecord(event.data);
  if (data === undefined) {
    throw new ProtocolError(
      `durable event ${event.type} from ${origin} has non-object data`,
    );
  }
  return { type: event.type, seq: event.seq, time: event.time, data };
}
