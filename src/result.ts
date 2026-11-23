/**
 * Read-back path for a previously accepted prompt (spec §7) and the
 * append-only local send index (spec §5 step 4).
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type DurableEvent,
  type FollowStream,
  type SessionClient,
  type SessionRow,
  type StreamRecord,
  sessionCursor,
  sessionUpdatedAt,
  stripSessionPrefix,
} from './client.js';
import { ProtocolError, ResultNotFoundError, RpcError } from './errors.js';
import {
  type AwaitTurnOptions,
  type SendIndexSink,
  type SendOutcome,
  type SendRecord,
  type ReconstructedTurn,
  type SendResult,
  type TurnOutcome,
  awaitTurn,
  exitCodeForStatus,
  reconstructTurn,
  statusForReasonKind,
  zeroUsage,
} from './run.js';

/** Maximum sessions × pages scanned when the rpcId is not in the index. */
const SCAN_SESSIONS = 50;
const SCAN_PAGES = 2;
const SCAN_PAGE_MESSAGES = 20;
const HISTORY_PAGE_MESSAGES = 200;
const HISTORY_MAX_PAGES = 50;

/** Append-only JSONL index at `$DSH_HOME/dsh-bridge/sends.jsonl`. */
export class SendIndex implements SendIndexSink {
  readonly path: string;

  constructor(dshHome: string) {
    this.path = join(dshHome, 'dsh-bridge', 'sends.jsonl');
  }

  /** Append one accepted send. Best-effort: never throws. */
  append(record: SendRecord): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // §5 step 4: the accepted turn must survive a broken index.
    }
  }

  /** Latest record for an rpcId, or undefined. Malformed lines are skipped. */
  lookup(rpcId: string): SendRecord | undefined {
    let source: string;
    try {
      source = readFileSync(this.path, 'utf8');
    } catch {
      return undefined;
    }
    let found: SendRecord | undefined;
    for (const line of source.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      if (
        record.rpcId === rpcId &&
        typeof record.sessionId === 'string' &&
        typeof record.from === 'string' &&
        typeof record.createdAt === 'number'
      ) {
        found = {
          rpcId,
          sessionId: record.sessionId,
          from: record.from,
          createdAt: record.createdAt,
        };
      }
    }
    return found;
  }
}

export interface ResultOptions {
  client: SessionClient;
  index: SendIndex;
  rpcId: string;
  wait?: boolean;
  timeoutMs: number;
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function eventsOf(records: readonly StreamRecord[]): DurableEvent[] {
  const events: DurableEvent[] = [];
  for (const record of records) {
    if (record.type !== 'event') continue;
    const event = asRecord(record.event);
    if (
      event !== undefined &&
      typeof event.type === 'string' &&
      typeof event.seq === 'number' &&
      typeof event.time === 'number'
    ) {
      events.push({
        type: event.type,
        seq: event.seq,
        time: event.time,
        data: asRecord(event.data) ?? {},
      });
    }
  }
  return events.sort((left, right) => left.seq - right.seq);
}

function findRow(rows: readonly SessionRow[], sessionId: string): SessionRow | undefined {
  const wanted = stripSessionPrefix(sessionId);
  return rows.find((row) => stripSessionPrefix(row.sessionId) === wanted);
}

function hasUserMessage(events: readonly DurableEvent[], rpcId: string): boolean {
  return events.some((event) => {
    if (event.type !== 'user/message') return false;
    const source = asRecord(event.data.source);
    return source?.kind === 'user' && source.rpcId === rpcId;
  });
}

/** Bounded scan: 50 newest sessions × 2 tail pages (spec §7 step 1). */
async function scanForRpcId(
  client: SessionClient,
  rpcId: string,
): Promise<SessionRow | undefined> {
  const rows = [...(await client.listSessions())].sort(
    (left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left),
  );
  sessionScan: for (const row of rows.slice(0, SCAN_SESSIONS)) {
    let throughSeq = sessionCursor(row);
    if (throughSeq === undefined) continue;
    const pages: DurableEvent[] = [];
    for (let page = 0; page < SCAN_PAGES; page++) {
      let result;
      try {
        result = await client.pageSession(row.sessionId, throughSeq, SCAN_PAGE_MESSAGES);
      } catch (error) {
        // A session page can fail independently (subagent sessions require
        // their parent address, or the session vanished between list and page);
        // the bounded scan moves on.
        if (error instanceof ProtocolError || error instanceof RpcError) continue sessionScan;
        throw error;
      }
      pages.push(...eventsOf(result.records));
      if (hasUserMessage(pages, rpcId)) return row;
      if (!result.hasMore) break;
      const minSeq = pages.reduce<number | undefined>(
        (min, event) => (min === undefined || event.seq < min ? event.seq : min),
        undefined,
      );
      if (minSeq === undefined || minSeq <= 0) break;
      throughSeq = minSeq - 1;
    }
  }
  return undefined;
}

function userEventOf(events: readonly DurableEvent[], rpcId: string): DurableEvent | undefined {
  return events.find((event) => {
    if (event.type !== 'user/message') return false;
    const source = asRecord(event.data.source);
    return source?.kind === 'user' && source.rpcId === rpcId;
  });
}

function turnStartFor(
  events: readonly DurableEvent[],
  userSeq: number,
): { turn: number; seq: number } | undefined {
  let found: { turn: number; seq: number } | undefined;
  for (const event of events) {
    if (event.seq > userSeq) break;
    if (event.type !== 'turn/start') continue;
    const turn = event.data.turn;
    if (typeof turn === 'number' && Number.isSafeInteger(turn)) found = { turn, seq: event.seq };
  }
  return found;
}

interface History {
  events: DurableEvent[];
  reconstructed: ReconstructedTurn | undefined;
}

/**
 * Page backwards from the live cursor until the rpcId's user/message and its
 * turn/start are both present. The follow snapshot itself is capped (it reports
 * `hasMore`), so read-back must not rely on it for long sessions.
 */
async function loadTurnHistory(
  client: SessionClient,
  sessionId: string,
  cursor: number,
  rpcId: string,
): Promise<History> {
  const bySeq = new Map<number, DurableEvent>();
  let throughSeq = cursor;
  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    const result = await client.pageSession(sessionId, throughSeq, HISTORY_PAGE_MESSAGES);
    const events = eventsOf(result.records);
    for (const event of events) bySeq.set(event.seq, event);
    const combined = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
    const userEvent = userEventOf(combined, rpcId);
    if (userEvent !== undefined) {
      const turnStart = turnStartFor(combined, userEvent.seq);
      if (turnStart !== undefined) {
        return { events: combined, reconstructed: reconstructTurn(combined, rpcId) };
      }
    }
    if (!result.hasMore) return { events: combined, reconstructed: undefined };
    const minSeq = events.reduce<number | undefined>(
      (min, event) => (min === undefined || event.seq < min ? event.seq : min),
      undefined,
    );
    if (minSeq === undefined || minSeq <= 0) {
      return { events: combined, reconstructed: undefined };
    }
    throughSeq = minSeq - 1;
  }
  const combined = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
  return { events: combined, reconstructed: undefined };
}

/**
 * Resolve the session for an rpcId: local index first, then the bounded scan.
 */
async function resolveResultSession(
  client: SessionClient,
  index: SendIndex,
  rpcId: string,
): Promise<{ sessionId: string; from: string; row: SessionRow }> {
  const entry = index.lookup(rpcId);
  if (entry !== undefined) {
    const row = findRow(await client.listSessions(), entry.sessionId);
    if (row === undefined) {
      throw new ResultNotFoundError(
        `send index points at session ${entry.sessionId} for rpcId ${rpcId}, but that session ` +
          `does not exist on ${client.host}`,
      );
    }
    return { sessionId: row.sessionId, from: entry.from, row };
  }

  const row = await scanForRpcId(client, rpcId);
  if (row === undefined) {
    throw new ResultNotFoundError(
      `rpcId ${rpcId} is not in the send index (${index.path}) and no user/message carrying it ` +
        `appears in the tail of the ${String(SCAN_SESSIONS)} most recently updated sessions on ${client.host}`,
    );
  }
  return { sessionId: row.sessionId, from: 'unknown', row };
}

function durationFor(userTime: number, endTime: number | undefined, fallback: number): number {
  if (endTime !== undefined && endTime >= userTime) return endTime - userTime;
  return Math.max(0, fallback);
}

function finalFromReconstruction(
  reconstructed: ReconstructedTurn,
  base: { rpcId: string; sessionId: string; from: string; host: string },
  now: number,
): SendOutcome {
  const ended = reconstructed.ended;
  const status = ended ? statusForReasonKind(reconstructed.reason?.kind) : 'pending';
  const result: SendResult = {
    rpcId: base.rpcId,
    sessionId: base.sessionId,
    from: base.from,
    turn: reconstructed.turn,
    status,
    reason: reconstructed.reason ?? { kind: status },
    // Spec §6: plain stdout is the *final* text; a running turn has none, so
    // the object plain mode prints carries an empty `text`. What settled so far
    // stays available to `--json` consumers as `partialText` (P1-2).
    text: ended ? reconstructed.text : '',
    ...(ended || reconstructed.text === '' ? {} : { partialText: reconstructed.text }),
    toolCalls: reconstructed.toolCalls,
    durationMs: durationFor(reconstructed.userEvent.time, reconstructed.endTime, now - reconstructed.userEvent.time),
    usage: reconstructed.usage,
    host: base.host,
  };
  return { result, exitCode: exitCodeForStatus(status) };
}

function pendingResult(
  base: { rpcId: string; sessionId: string; from: string; host: string },
  turn: number | undefined,
): SendOutcome {
  return {
    result: {
      rpcId: base.rpcId,
      sessionId: base.sessionId,
      from: base.from,
      ...(turn === undefined ? {} : { turn }),
      status: 'pending',
      reason: { kind: 'pending' },
      text: '',
      toolCalls: [],
      durationMs: 0,
      usage: zeroUsage(),
      host: base.host,
    },
    exitCode: 0,
  };
}

function fromOutcome(
  outcome: TurnOutcome,
  base: { rpcId: string; sessionId: string; from: string; host: string },
): SendOutcome {
  // `result --wait` lands here as `pending` when the stream ends before
  // turn/end: same rule as finalFromReconstruction, no final text yet (P1-2).
  const pending = outcome.status === 'pending';
  const result: SendResult = {
    rpcId: base.rpcId,
    sessionId: base.sessionId,
    from: base.from,
    ...(outcome.turn === undefined ? {} : { turn: outcome.turn }),
    status: outcome.status,
    reason: outcome.reason ?? { kind: outcome.status },
    text: pending ? '' : outcome.text,
    ...(pending && outcome.text !== '' ? { partialText: outcome.text } : {}),
    toolCalls: outcome.toolCalls,
    durationMs: outcome.durationMs,
    usage: outcome.usage,
    host: base.host,
  };
  return { result, exitCode: exitCodeForStatus(outcome.status) };
}

async function enforceTurnEnd(
  options: ResultOptions,
  stream: FollowStream,
  initialEvents: readonly DurableEvent[],
  base: { rpcId: string; sessionId: string; from: string; host: string },
): Promise<SendOutcome> {
  const awaitOptions: AwaitTurnOptions = {
    stream,
    rpcId: options.rpcId,
    timeoutMs: options.timeoutMs,
    initialEvents,
    missingEnd: 'pending',
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const outcome = await awaitTurn(awaitOptions);
  if (!outcome.matched && options.index.lookup(options.rpcId) === undefined) {
    throw new ResultNotFoundError(
      `rpcId ${options.rpcId} disappeared from session ${base.sessionId} before its turn/end arrived`,
    );
  }
  const rendered = fromOutcome(outcome, base);
  if (outcome.status === 'timeout') {
    return {
      ...rendered,
      timeoutHint:
        `dsh-bridge: result --wait timed out after ${String(Math.round(options.timeoutMs / 1000))}s; ` +
        `rpcId ${options.rpcId} is still pending. Re-run: dsh-bridge result --rpc-id ${options.rpcId} --wait`,
    };
  }
  return rendered;
}

/** `result --rpc-id`: reconstruct a prior send without prompting anything. */
export async function resultMessage(options: ResultOptions): Promise<SendOutcome> {
  const now = options.now ?? Date.now;
  if (options.rpcId.trim() === '') {
    throw new ResultNotFoundError('--rpc-id must not be empty');
  }
  const resolved = await resolveResultSession(options.client, options.index, options.rpcId);
  const base = {
    rpcId: options.rpcId,
    sessionId: resolved.sessionId,
    from: resolved.from,
    host: options.client.host,
  };
  const entry = options.index.lookup(options.rpcId);
  const stream = await options.client.followSession(resolved.sessionId);
  try {
    const history = await loadTurnHistory(
      options.client,
      resolved.sessionId,
      stream.snapshot.cursor,
      options.rpcId,
    );

    if (options.wait !== true) {
      stream.close();
      if (history.reconstructed !== undefined) {
        return finalFromReconstruction(history.reconstructed, base, now());
      }
      if (entry !== undefined) return pendingResult(base, undefined);
      throw new ResultNotFoundError(
        `rpcId ${options.rpcId} was not found in the durable log of session ${resolved.sessionId} ` +
          `on ${options.client.host}`,
      );
    }

    if (history.reconstructed !== undefined && history.reconstructed.ended) {
      stream.close();
      return finalFromReconstruction(history.reconstructed, base, now());
    }
    if (history.reconstructed === undefined && entry === undefined) {
      stream.close();
      throw new ResultNotFoundError(
        `rpcId ${options.rpcId} was not found in the durable log of session ${resolved.sessionId} ` +
          `on ${options.client.host}`,
      );
    }
    // Await the wait path so the `finally` closes only after it settles.
    return await enforceTurnEnd(options, stream, history.events, base);
  } finally {
    // The follow socket must never outlive this call: `loadTurnHistory` can
    // throw after the open (pageSession policy/HTTP failures), and an open
    // socket keeps the event loop alive, parking the process forever (P1-1).
    stream.close();
  }
}
