import assert from 'node:assert/strict';
import test from 'node:test';
import type { DurableEvent } from '../src/client.js';
import {
  collectToolCalls,
  collectTurn,
  exitCodeForStatus,
  reconstructTurn,
  renderAssistantText,
  statusForReasonKind,
  sumUsage,
  zeroUsage,
} from '../src/run.js';

function event(type: string, seq: number, data: Record<string, unknown>, time = seq * 10): DurableEvent {
  return { type, seq, time, data };
}

test('status mapping follows spec §6', () => {
  assert.equal(statusForReasonKind('completed'), 'completed');
  assert.equal(statusForReasonKind('max-tokens'), 'completed');
  assert.equal(statusForReasonKind('aborted'), 'cancelled');
  assert.equal(statusForReasonKind('blocked'), 'error');
  assert.equal(statusForReasonKind('error'), 'error');
  assert.equal(statusForReasonKind('something-new'), 'error');
  assert.equal(statusForReasonKind(undefined), 'error');
});

test('exit codes follow spec §6', () => {
  assert.equal(exitCodeForStatus('completed'), 0);
  assert.equal(exitCodeForStatus('pending'), 0);
  assert.equal(exitCodeForStatus('timeout'), 2);
  assert.equal(exitCodeForStatus('error'), 3);
  assert.equal(exitCodeForStatus('cancelled'), 3);
});

test('plain text is only our turn, text blocks joined by a blank line', () => {
  const events = [
    event('assistant/message', 10, {
      turn: 1,
      message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'A' }] },
    }),
    event('assistant/message', 12, {
      turn: 1,
      message: { content: [{ type: 'text', text: 'B' }, { type: 'tool-call', name: 'bash' }] },
    }),
    event('assistant/message', 14, { turn: 2, message: { content: [{ type: 'text', text: 'other' }] } }),
  ];
  assert.equal(renderAssistantText(events, 1), 'A\n\nB');
  assert.equal(renderAssistantText(events, 2), 'other');
  assert.equal(renderAssistantText(events, undefined), '');
});

test('usage sums every assistant message of the turn; missing fields are zero', () => {
  const events = [
    event('assistant/message', 1, { turn: 1, usage: { inputTokens: 10, outputTokens: 2 } }),
    event('assistant/message', 2, {
      turn: 1,
      usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 7 },
    }),
    event('assistant/message', 3, { turn: 2, usage: { inputTokens: 100, outputTokens: 100 } }),
    event('assistant/message', 4, { turn: 1 }),
  ];
  assert.deepEqual(sumUsage(events, 1), { inputTokens: 15, outputTokens: 5, cacheReadTokens: 7 });
  assert.deepEqual(sumUsage(events, undefined), zeroUsage());
});

test('tool calls keep call order and need a matching result', () => {
  const events = [
    event('tool/call', 10, { turn: 1, callId: 'c1', name: 'bash' }),
    event('tool/result', 11, { turn: 1, message: { toolCallId: 'c1', isError: false } }),
    event('tool/call', 12, { turn: 1, callId: 'c2', name: 'read' }),
    event('tool/result', 13, { turn: 1, message: { toolCallId: 'c2' }, error: { code: 'E' } }),
    event('tool/call', 14, { turn: 1, callId: 'c3', name: 'glob' }),
    event('tool/call', 15, { turn: 2, callId: 'other', name: 'ignored' }),
    event('tool/result', 16, { turn: 2, message: { toolCallId: 'other' } }),
  ];
  assert.deepEqual(collectToolCalls(events, 1), [
    { name: 'bash', ok: true },
    { name: 'read', ok: false },
    { name: 'glob', ok: false },
  ]);
});

test('collectTurn carries the raw turn/end reason', () => {
  const events = [
    event('assistant/message', 1, { turn: 1, message: { content: [{ type: 'text', text: 'hi' }] } }),
    event('tool/call', 2, { turn: 1, callId: 'c', name: 'bash' }),
    event('tool/result', 3, { turn: 1, message: { toolCallId: 'c' } }),
    event('turn/end', 4, { turn: 1, reason: { kind: 'aborted', reason: 'user' } }, 999),
  ];
  const turn = collectTurn(events, 1);
  assert.equal(turn.text, 'hi');
  assert.deepEqual(turn.reason, { kind: 'aborted', reason: 'user' });
  assert.equal(turn.endTime, 999);
  assert.deepEqual(turn.toolCalls, [{ name: 'bash', ok: true }]);
});

test('reconstructTurn finds a sent message and whether its turn ended', () => {
  const events = [
    event('turn/start', 1, { turn: 1 }),
    event('user/message', 2, { source: { kind: 'user', rpcId: 'wanted' }, content: [] }),
    event('assistant/message', 3, {
      turn: 1,
      message: { content: [{ type: 'text', text: 'answer' }] },
      usage: { inputTokens: 4, outputTokens: 5 },
    }),
    event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }, 40),
  ];
  const found = reconstructTurn(events, 'wanted');
  assert.notEqual(found, undefined);
  assert.equal(found?.turn, 1);
  assert.equal(found?.ended, true);
  assert.equal(found?.text, 'answer');
  assert.deepEqual(found?.usage, { inputTokens: 4, outputTokens: 5, cacheReadTokens: 0 });
  assert.equal(found?.endTime, 40);

  const pending = reconstructTurn(events.slice(0, 3), 'wanted');
  assert.equal(pending?.ended, false);
  assert.equal(reconstructTurn(events, 'missing'), undefined);
});

test('reconstructTurn ignores non-user rpcId sources', () => {
  const events = [
    event('turn/start', 1, { turn: 1 }),
    event('user/message', 2, { source: { kind: 'time-context', rpcId: 'wanted' }, content: [] }),
  ];
  assert.equal(reconstructTurn(events, 'wanted'), undefined);
});
