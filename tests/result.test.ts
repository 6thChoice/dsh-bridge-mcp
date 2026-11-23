/**
 * Unit coverage for the `result` read-back path (spec §7) with a fake client:
 * no host, no network. The fake is a plain object cast to `SessionClient`,
 * the same style the MCP tests use for their handler payloads.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  type DurableEvent,
  type FollowStream,
  type SessionClient,
  type SessionPage,
  type SessionRow,
  type StreamRecord,
} from '../src/client.js';
import { RpcError } from '../src/errors.js';
import { SendIndex, resultMessage } from '../src/result.js';

const homes: string[] = [];

after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-result-'));
  homes.push(home);
  return home;
}

/** A follow stream that records `close()` and never yields an event. */
class FakeStream {
  readonly snapshot = { cursor: 100, records: [] as StreamRecord[] };
  /** Real `close()` is idempotent; this flag answers "was it closed at all?". */
  closed = false;

  async *events(): AsyncGenerator<DurableEvent> {
    // A `--wait` path would block on this iterator; these tests do not wait.
  }

  snapshotEvents(): DurableEvent[] {
    return [];
  }

  close(): void {
    this.closed = true;
  }
}

interface Fake {
  client: SessionClient;
  stream: FakeStream;
}

function fakeClient(
  page: (throughSeq: number) => Promise<SessionPage>,
  sessionId = 'session-test',
): Fake {
  const stream = new FakeStream();
  const row: SessionRow = { sessionId, updatedAt: 1, projections: { asOfSeq: 100 } };
  const client = {
    host: 'http://127.0.0.1:1',
    listSessions: async (): Promise<SessionRow[]> => [row],
    followSession: async (): Promise<FollowStream> => stream as unknown as FollowStream,
    pageSession: async (_sessionId: string, throughSeq: number): Promise<SessionPage> =>
      page(throughSeq),
  } as unknown as SessionClient;
  return { client, stream };
}

function event(
  type: string,
  seq: number,
  data: Record<string, unknown>,
  time = seq * 10,
): DurableEvent {
  return { type, seq, time, data };
}

function recordOf(durable: DurableEvent): StreamRecord {
  return { type: 'event', event: durable };
}

function indexed(home: string, rpcId: string): SendIndex {
  const index = new SendIndex(home);
  index.append({ rpcId, sessionId: 'session-test', from: 'test', createdAt: 1 });
  return index;
}

test('a pageSession failure after the follow opens still closes the stream (P1-1)', async () => {
  const home = tempHome();
  const index = indexed(home, 'rpc-1');
  const { client, stream } = fakeClient(async () => {
    throw new RpcError(
      'session/page',
      'session/agent-busy',
      'subagent sessions require their parent address',
    );
  });

  await assert.rejects(
    resultMessage({ client, index, rpcId: 'rpc-1', timeoutMs: 5_000 }),
    (error: unknown) => error instanceof RpcError && error.code === 'session/agent-busy',
  );
  assert.equal(
    stream.closed,
    true,
    'the follow socket must be closed when loadTurnHistory throws after the open',
  );
});

test('a running turn has no final text: pending keeps text empty (P1-2)', async () => {
  const home = tempHome();
  const rpcId = 'rpc-2';
  const index = indexed(home, rpcId);
  const events = [
    event('turn/start', 90, { turn: 3 }),
    event('user/message', 91, { source: { kind: 'user', rpcId }, content: [] }),
    event('assistant/message', 92, {
      turn: 3,
      message: { content: [{ type: 'text', text: 'PARTIAL' }] },
    }),
  ];
  const { client, stream } = fakeClient(async () => ({
    records: events.map(recordOf),
    hasMore: false,
  }));

  const outcome = await resultMessage({ client, index, rpcId, timeoutMs: 5_000 });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, 'pending');
  assert.equal(outcome.result.text, '');
  assert.equal(outcome.result.partialText, 'PARTIAL');
  assert.equal(stream.closed, true);
});
