/**
 * The await engine and result rendering (spec §5–§6).
 *
 * Completion is defined by durable events, never by polling: find the
 * `user/message` carrying our `requestId`, use the `turn/start` at or before
 * it, then wait for that turn's `turn/end`. Text and tool calls are collected
 * only from that turn.
 */

import { randomUUID } from 'node:crypto';
import type { DurableEvent, FollowStream, SessionClient } from './client.js';
import { ProtocolError, ResolutionError } from './errors.js';
import { type Target, resolveTarget } from './resolve.js';

export type TurnStatus = 'completed' | 'error' | 'cancelled' | 'timeout' | 'pending';

export interface ToolCallOutcome {
  name: string;
  ok: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface SendRecord {
  rpcId: string;
  sessionId: string;
  from: string;
  createdAt: number;
}

/** Append-only sink for §5 step 4. `SendIndex` in result.ts implements it. */
export interface SendIndexSink {
  append(record: SendRecord): void;
}

export interface SendResult {
  rpcId: string;
  sessionId: string;
  from: string;
  turn?: number;
  status: TurnStatus;
  reason: Record<string, unknown>;
  /** Final assistant text of our turn; empty unless the turn ended (spec §6). */
  text: string;
  /** Settled assistant text seen before a `pending` turn ended; JSON-only field. */
  partialText?: string;
  toolCalls: ToolCallOutcome[];
  durationMs: number;
  usage: Usage;
  host: string;
}

export interface SendOutcome {
  result: SendResult;
  exitCode: number;
  /** One-line stderr hint when status is `timeout`. */
  timeoutHint?: string;
}

export interface SendMessageOptions {
  client: SessionClient;
  target: Target;
  text: string;
  /** `[via <from>]` label; ignored when `prefix` is false. */
  from: string;
  prefix?: boolean;
  mode?: 'queue' | 'steer';
  timeoutMs: number;
  detach?: boolean;
  force?: boolean;
  index?: SendIndexSink;
  now?: () => number;
}

export function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}

/** Spec §6 status mapping from `turn/end.reason.kind`. */
export function statusForReasonKind(kind: unknown): 'completed' | 'cancelled' | 'error' {
  if (kind === 'completed' || kind === 'max-tokens') return 'completed';
  if (kind === 'aborted') return 'cancelled';
  return 'error';
}

export function exitCodeForStatus(status: TurnStatus): number {
  switch (status) {
    case 'completed':
    case 'pending':
      return 0;
    case 'timeout':
      return 2;
    case 'cancelled':
    case 'error':
      return 3;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/** rpcId of a user/message event, if it is a real user-sourced message. */
export function userMessageRpcId(event: DurableEvent): string | undefined {
  if (event.type !== 'user/message') return undefined;
  const source = asRecord(event.data.source);
  if (source?.kind !== 'user') return undefined;
  return stringField(source, 'rpcId');
}

/** Join the text blocks of our turn's assistant messages with one blank line. */
export function renderAssistantText(events: readonly DurableEvent[], turn: number | undefined): string {
  if (turn === undefined) return '';
  const texts: string[] = [];
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type !== 'assistant/message') continue;
    if (numberField(event.data, 'turn') !== turn) continue;
    const message = asRecord(event.data.message);
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const record = asRecord(block);
      if (record?.type !== 'text') continue;
      const text = stringField(record, 'text');
      if (text !== undefined && text !== '') texts.push(text);
    }
  }
  return texts.join('\n\n');
}

/** Sum `data.usage` across our turn's assistant messages; missing fields are 0. */
export function sumUsage(events: readonly DurableEvent[], turn: number | undefined): Usage {
  const usage = zeroUsage();
  if (turn === undefined) return usage;
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    if (numberField(event.data, 'turn') !== turn) continue;
    const raw = asRecord(event.data.usage);
    if (raw === undefined) continue;
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens'] as const) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value)) usage[key] += value;
    }
  }
  return usage;
}

/** Tool calls of our turn, in call order; `ok` needs a matching non-error result. */
export function collectToolCalls(
  events: readonly DurableEvent[],
  turn: number | undefined,
): ToolCallOutcome[] {
  if (turn === undefined) return [];
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const calls: { callId: string; name: string; ok: boolean }[] = [];
  const byCallId = new Map<string, { callId: string; name: string; ok: boolean }>();

  for (const event of ordered) {
    if (numberField(event.data, 'turn') !== turn) continue;
    if (event.type === 'tool/call') {
      const callId = stringField(event.data, 'callId');
      const name = stringField(event.data, 'name') ?? '';
      if (callId === undefined) continue;
      const call = { callId, name, ok: false };
      calls.push(call);
      byCallId.set(callId, call);
      continue;
    }
    if (event.type === 'tool/result') {
      const message = asRecord(event.data.message);
      const content = message?.content;
      const firstBlock = Array.isArray(content) ? asRecord(content[0]) : undefined;
      // 0.2.x carries the id at the top level; 0.1.x only in
      // `message.source.callId` and `message.content[0].toolCallId` (spec §3.5).
      const callId =
        stringField(message, 'toolCallId') ??
        stringField(event.data, 'callId') ??
        stringField(message, 'callId') ??
        stringField(asRecord(message?.source), 'callId') ??
        stringField(firstBlock, 'toolCallId');
      if (callId === undefined) continue;
      const call = byCallId.get(callId);
      if (call === undefined) continue;
      // Spec §6: false when the result carries data.error; true otherwise.
      call.ok = event.data.error === undefined || event.data.error === null;
    }
  }
  return calls.map((call) => ({ name: call.name, ok: call.ok }));
}

interface TurnSnapshot {
  text: string;
  toolCalls: ToolCallOutcome[];
  usage: Usage;
  reason: Record<string, unknown> | undefined;
  /** Durable time of our turn's `turn/end`, when it has ended. */
  endTime: number | undefined;
}

/** Everything §6 needs from a turn's durable events. */
export function collectTurn(events: readonly DurableEvent[], turn: number | undefined): TurnSnapshot {
  let reason: Record<string, unknown> | undefined;
  let endTime: number | undefined;
  if (turn !== undefined) {
    for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
      if (event.type !== 'turn/end') continue;
      if (numberField(event.data, 'turn') !== turn) continue;
      reason = asRecord(event.data.reason) ?? { kind: 'unknown' };
      endTime = event.time;
      break;
    }
  }
  return {
    text: renderAssistantText(events, turn),
    toolCalls: collectToolCalls(events, turn),
    usage: sumUsage(events, turn),
    reason,
    endTime,
  };
}

export interface ReconstructedTurn extends TurnSnapshot {
  /** `user/message` event that carried the rpcId. */
  userEvent: DurableEvent;
  turn: number;
  ended: boolean;
}

/**
 * Find a previously sent message in a session log and collect its turn.
 * Returns undefined when the rpcId does not appear in `events`.
 */
export function reconstructTurn(
  events: readonly DurableEvent[],
  rpcId: string,
): ReconstructedTurn | undefined {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  let currentTurn: number | undefined;
  let userEvent: DurableEvent | undefined;
  for (const event of ordered) {
    if (event.type === 'turn/start') {
      const turn = numberField(event.data, 'turn');
      if (turn !== undefined) currentTurn = turn;
      continue;
    }
    if (userEvent === undefined && userMessageRpcId(event) === rpcId) {
      if (currentTurn === undefined) {
        throw new ProtocolError(
          `user/message for rpcId ${rpcId} appeared before any turn/start in the session log`,
        );
      }
      userEvent = event;
      break;
    }
  }
  if (userEvent === undefined) return undefined;
  const turn = currentTurn;
  if (turn === undefined) return undefined;
  const snapshot = collectTurn(ordered, turn);
  return {
    ...snapshot,
    userEvent,
    turn,
    ended: snapshot.reason !== undefined,
  };
}

export interface AwaitTurnOptions {
  stream: FollowStream;
  rpcId: string;
  timeoutMs: number;
  /** Events already delivered before the live iterator (snapshot records). */
  initialEvents?: readonly DurableEvent[];
  /** What to report when the stream ends without `turn/end`. */
  missingEnd: 'error' | 'pending';
  now?: () => number;
  startedAt?: number;
}

export interface TurnOutcome extends TurnSnapshot {
  status: TurnStatus;
  turn?: number;
  /** True when our user/message was never delivered before the deadline. */
  matched: boolean;
  timedOut: boolean;
  durationMs: number;
}

const TIMEOUT = Symbol('timeout');

async function nextWithTimeout(
  iterator: AsyncIterator<DurableEvent>,
  timeoutMs: number,
): Promise<IteratorResult<DurableEvent> | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMEOUT);
    }, timeoutMs);
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Wait for the turn carrying `rpcId` to end. The stream is closed on every
 * exit path, including timeout.
 */
export async function awaitTurn(options: AwaitTurnOptions): Promise<TurnOutcome> {
  const now = options.now ?? Date.now;
  const startedAt = options.startedAt ?? now();
  const deadline = startedAt + options.timeoutMs;
  const events: DurableEvent[] = [...(options.initialEvents ?? [])].sort(
    (left, right) => left.seq - right.seq,
  );
  const iterator = options.stream.events()[Symbol.asyncIterator]();

  let currentTurn: number | undefined;
  let matchedEvent: DurableEvent | undefined;
  let turn: number | undefined;
  let reason: Record<string, unknown> | undefined;

  const scan = (event: DurableEvent): void => {
    if (event.type === 'turn/start') {
      const started = numberField(event.data, 'turn');
      if (started !== undefined) currentTurn = started;
      return;
    }
    if (matchedEvent === undefined && userMessageRpcId(event) === options.rpcId) {
      if (currentTurn === undefined) {
        throw new ProtocolError(
          `user/message for rpcId ${options.rpcId} appeared before any turn/start on the follow stream`,
        );
      }
      matchedEvent = event;
      turn = currentTurn;
      return;
    }
    if (turn !== undefined && event.type === 'turn/end' && numberField(event.data, 'turn') === turn) {
      reason = asRecord(event.data.reason) ?? { kind: 'unknown' };
    }
  };

  let timedOut = false;
  let streamEnded = false;
  try {
    for (const event of events) scan(event);
    while (reason === undefined) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      const next = await nextWithTimeout(iterator, remaining);
      if (next === TIMEOUT) {
        timedOut = true;
        break;
      }
      if (next.done === true) {
        streamEnded = true;
        break;
      }
      events.push(next.value);
      scan(next.value);
    }
  } finally {
    options.stream.close();
  }

  const snapshot = collectTurn(events, turn);
  const durationMs = Math.max(0, now() - startedAt);

  if (reason !== undefined) {
    return {
      ...snapshot,
      status: statusForReasonKind(reason.kind),
      ...(turn === undefined ? {} : { turn }),
      matched: matchedEvent !== undefined,
      timedOut: false,
      durationMs,
    };
  }
  if (timedOut) {
    return {
      ...snapshot,
      status: 'timeout',
      ...(turn === undefined ? {} : { turn }),
      matched: matchedEvent !== undefined,
      timedOut: true,
      durationMs,
    };
  }
  if (options.missingEnd === 'pending') {
    return {
      ...snapshot,
      status: 'pending',
      ...(turn === undefined ? {} : { turn }),
      matched: matchedEvent !== undefined,
      timedOut: false,
      durationMs,
    };
  }
  throw new ProtocolError(
    matchedEvent === undefined
      ? `session/follow ended before user/message for rpcId ${options.rpcId} appeared`
      : `session/follow ended before turn/end for turn ${String(turn)}` +
          ` (streamEnded=${String(streamEnded)})`,
  );
}

function buildResult(
  base: { rpcId: string; sessionId: string; from: string; host: string },
  outcome: TurnOutcome,
): SendResult {
  return {
    rpcId: base.rpcId,
    sessionId: base.sessionId,
    from: base.from,
    ...(outcome.turn === undefined ? {} : { turn: outcome.turn }),
    status: outcome.status,
    reason: outcome.reason ?? { kind: outcome.status },
    text: outcome.text,
    toolCalls: outcome.toolCalls,
    durationMs: outcome.durationMs,
    usage: outcome.usage,
    host: base.host,
  };
}

/** One `send`: resolve, follow, prompt, index, await, render (spec §5). */
export async function sendMessage(options: SendMessageOptions): Promise<SendOutcome> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const rows = await options.client.listSessions();
  const row = resolveTarget(rows, options.target);
  if (row.agentAvailable === false && options.force !== true) {
    throw new ResolutionError(
      `session ${row.sessionId} is not available to the agent (agentAvailable=false); ` +
        'pass --force to send anyway',
    );
  }

  const from = options.from;
  const text = options.prefix === false ? options.text : `[via ${from}] ${options.text}`;
  const requestId = randomUUID();
  const stream = await options.client.followSession(row.sessionId);

  try {
    await options.client.prompt({
      sessionId: row.sessionId,
      requestId,
      mode: options.mode ?? 'queue',
      text,
    });
  } catch (error) {
    stream.close();
    throw error;
  }

  try {
    options.index?.append({ rpcId: requestId, sessionId: row.sessionId, from, createdAt: now() });
  } catch {
    // §5 step 4: best-effort; a broken index must not lose the accepted turn.
  }

  const base = { rpcId: requestId, sessionId: row.sessionId, from, host: options.client.host };

  if (options.detach === true) {
    stream.close();
    const durationMs = Math.max(0, now() - startedAt);
    return {
      result: {
        rpcId: requestId,
        sessionId: row.sessionId,
        from,
        status: 'pending',
        reason: { kind: 'pending' },
        text: '',
        toolCalls: [],
        durationMs,
        usage: zeroUsage(),
        host: options.client.host,
      },
      exitCode: 0,
    };
  }

  const outcome = await awaitTurn({
    stream,
    rpcId: requestId,
    timeoutMs: options.timeoutMs,
    initialEvents: stream.snapshotEvents(),
    missingEnd: 'error',
    startedAt,
    now,
  });
  const result = buildResult(base, outcome);
  const timeoutHint =
    outcome.status === 'timeout'
      ? `dsh-bridge: timed out after ${String(Math.round(options.timeoutMs / 1000))}s; ` +
        `the turn is still pending (rpcId ${requestId}). Read it later with: ` +
        `dsh-bridge result --rpc-id ${requestId} --wait`
      : undefined;
  return {
    result,
    exitCode: exitCodeForStatus(outcome.status),
    ...(timeoutHint === undefined ? {} : { timeoutHint }),
  };
}
