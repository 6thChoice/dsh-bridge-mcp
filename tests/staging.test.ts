/**
 * Staging integration tests (spec §11): every send targets a disposable
 * `dsh web` with a stub provider. No real model or user session is touched.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { asRecord, sessionCursor } from '../src/client.js';
import {
  logHasRpcId,
  rowFor,
  runCli,
  startStaging,
  waitUntilRunning,
  type Staging,
  type StubResponse,
} from './staging.js';

let staging: Staging;

before(async () => {
  staging = await startStaging();
}, { timeout: 120_000 });

after(async () => {
  await staging?.stop();
}, { timeout: 30_000 });

function args(sessionId: string): string[] {
  return ['--host', staging.url, '--dsh-home', staging.home, '--session', sessionId];
}

function json(run: { stdout: string }): Record<string, unknown> {
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `--json must print exactly one line, got: ${run.stdout}`);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

/** Wait until the session log holds an assistant/message text block equal to `needle`. */
async function waitForAssistantText(
  sessionId: string,
  needle: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await rowFor(staging.client, sessionId);
    const cursor = sessionCursor(row);
    if (cursor !== undefined) {
      const page = await staging.client.pageSession(sessionId, cursor, 100);
      const found = page.records.some((record) => {
        if (record.type !== 'event') return false;
        const message = asRecord(asRecord(asRecord(record.event)?.data)?.message);
        const content = message?.content;
        if (!Array.isArray(content)) return false;
        return content.some((block) => {
          const entry = asRecord(block);
          return entry?.type === 'text' && entry.text === needle;
        });
      });
      if (found) return;
    }
    if (Date.now() > deadline) {
      throw new Error(`assistant text "${needle}" never appeared in session ${sessionId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('blocking send returns exactly the assistant text and records the rpcId', { timeout: 60_000 }, async () => {
  staging.stub.setHandler((request): StubResponse => {
    if (request.lastHumanText.includes('blocking-marker')) return { text: 'PONG-BLOCKING' };
    return { text: 'unexpected' };
  });
  const sessionId = await staging.createSession();

  const plain = await runCli(
    ['send', 'blocking-marker', ...args(sessionId), '--from', 'test', '--timeout', '20'],
    { home: staging.home },
  );
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.stdout, 'PONG-BLOCKING\n');
  assert.equal(plain.stderr, '');

  const call = staging.stub.agentCalls.find((request) =>
    request.lastHumanText.includes('blocking-marker'),
  );
  assert.equal(call?.lastHumanText, '[via test] blocking-marker');

  const withJson = await runCli(
    ['send', 'blocking-marker', ...args(sessionId), '--from', 'test', '--json', '--timeout', '20'],
    { home: staging.home },
  );
  assert.equal(withJson.code, 0, withJson.stderr);
  const result = json(withJson);
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'PONG-BLOCKING');
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.from, 'test');
  assert.equal(result.turn, 2);
  assert.equal(result.host, staging.url);
  assert.deepEqual(result.reason, { kind: 'completed' });
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 });
  assert.equal(typeof result.rpcId, 'string');
  assert.ok(await logHasRpcId(staging.client, sessionId, result.rpcId as string));
});

test('--no-prefix sends the raw text', { timeout: 60_000 }, async () => {
  staging.stub.setHandler((): StubResponse => ({ text: 'RAW' }));
  const sessionId = await staging.createSession();
  const run = await runCli(
    ['send', 'noprefix-marker', ...args(sessionId), '--no-prefix', '--timeout', '20'],
    { home: staging.home },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, 'RAW\n');
  const call = staging.stub.agentCalls.find((request) =>
    request.lastHumanText.includes('noprefix-marker'),
  );
  assert.equal(call?.lastHumanText, 'noprefix-marker');
});

test('--detach returns an rpcId, result is pending then completed', { timeout: 60_000 }, async () => {
  staging.stub.setHandler((): StubResponse => ({ text: 'DETACHED', delayMs: 1500 }));
  const sessionId = await staging.createSession();

  const started = Date.now();
  const detach = await runCli(
    ['send', 'detach-marker', ...args(sessionId), '--detach', '--timeout', '20'],
    { home: staging.home },
  );
  const elapsed = Date.now() - started;
  assert.equal(detach.code, 0, detach.stderr);
  const rpcId = detach.stdout.trim();
  assert.match(rpcId, /^[0-9a-f-]{36}$/);
  assert.ok(elapsed < 1500, `--detach must exit before the turn ends (took ${String(elapsed)}ms)`);

  const pending = await runCli(
    ['result', '--rpc-id', rpcId, '--json', '--dsh-home', staging.home, '--host', staging.url],
    { home: staging.home },
  );
  assert.equal(pending.code, 0, pending.stderr);
  assert.equal(json(pending).status, 'pending');

  const waited = await runCli(
    [
      'result',
      '--rpc-id',
      rpcId,
      '--wait',
      '--timeout',
      '10',
      '--json',
      '--dsh-home',
      staging.home,
      '--host',
      staging.url,
    ],
    { home: staging.home },
  );
  assert.equal(waited.code, 0, waited.stderr);
  const result = json(waited);
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'DETACHED');
  assert.equal(result.rpcId, rpcId);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.from, 'cli');
  assert.equal(result.host, staging.url);

  const afterTheFact = await runCli(
    ['result', '--rpc-id', rpcId, '--json', '--dsh-home', staging.home, '--host', staging.url],
    { home: staging.home },
  );
  assert.equal(afterTheFact.code, 0, afterTheFact.stderr);
  assert.equal(json(afterTheFact).status, 'completed');
});

test('timeout exits 2, names the rpcId, and hints how to read it later', { timeout: 60_000 }, async () => {
  staging.stub.setHandler((): StubResponse => ({ text: 'TOO-LATE', delayMs: 5000 }));
  const sessionId = await staging.createSession();
  const run = await runCli(
    ['send', 'timeout-marker', ...args(sessionId), '--timeout', '1', '--json'],
    { home: staging.home },
  );
  assert.equal(run.code, 2, run.stderr);
  const result = json(run);
  assert.equal(result.status, 'timeout');
  assert.equal(typeof result.rpcId, 'string');
  assert.match(run.stderr, /timed out/);
  assert.match(run.stderr, new RegExp(`result --rpc-id ${String(result.rpcId)}`));
});

test('queued send returns its own turn, never the running turn', { timeout: 90_000 }, async () => {
  staging.stub.setHandler((request): StubResponse => {
    if (request.lastHumanText.includes('queue-first')) {
      return { text: 'FIRST-TURN', delayMs: 2500 };
    }
    if (request.lastHumanText.includes('queue-second')) return { text: 'SECOND-TURN' };
    return { text: 'unexpected' };
  });
  const sessionId = await staging.createSession();

  const first = await runCli(
    ['send', 'queue-first', ...args(sessionId), '--detach', '--timeout', '20'],
    { home: staging.home },
  );
  assert.equal(first.code, 0, first.stderr);
  await waitUntilRunning(staging.client, sessionId);

  const second = await runCli(
    ['send', 'queue-second', ...args(sessionId), '--json', '--timeout', '30'],
    { home: staging.home },
  );
  assert.equal(second.code, 0, second.stderr);
  const result = json(second);
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'SECOND-TURN');
  assert.equal(result.turn, 2);
  assert.ok(!String(result.text).includes('FIRST-TURN'));
});

test('toolCalls and usage are populated from a real bash tool turn', { timeout: 90_000 }, async () => {
  staging.stub.setHandler((request): StubResponse => {
    if (request.hasToolResult) {
      return { text: 'TOOL-DONE', usage: { inputTokens: 20, outputTokens: 3 } };
    }
    if (!request.lastHumanText.includes('tool-marker')) return { text: 'unexpected' };
    return {
      toolCall: {
        name: 'bash',
        args: { command: 'echo tool-ok', description: 'Echo a test string' },
      },
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  });
  const sessionId = await staging.createSession();
  const run = await runCli(
    ['send', 'tool-marker', ...args(sessionId), '--json', '--timeout', '40'],
    { home: staging.home },
  );
  assert.equal(run.code, 0, run.stderr);
  const result = json(run);
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'TOOL-DONE');
  assert.deepEqual(result.toolCalls, [{ name: 'bash', ok: true }]);
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 5, cacheReadTokens: 0 });
});

test('result scans the newest sessions when the send index is gone', { timeout: 60_000 }, async () => {
  staging.stub.setHandler((): StubResponse => ({ text: 'SCAN-ME' }));
  const sessionId = await staging.createSession();
  const sent = await runCli(
    ['send', 'scan-marker', ...args(sessionId), '--json', '--timeout', '20'],
    { home: staging.home },
  );
  assert.equal(sent.code, 0, sent.stderr);
  const rpcId = json(sent).rpcId as string;
  rmSync(join(staging.home, 'dsh-bridge', 'sends.jsonl'), { force: true });

  const found = await runCli(
    ['result', '--rpc-id', rpcId, '--json', '--dsh-home', staging.home, '--host', staging.url],
    { home: staging.home },
  );
  assert.equal(found.code, 0, found.stderr);
  const result = json(found);
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'SCAN-ME');
  assert.equal(result.from, 'unknown');
});

test('sessions --json lists staging rows; unknown rpcId is a local error', { timeout: 60_000 }, async () => {
  const sessions = await runCli(['sessions', '--json', '--host', staging.url, '--dsh-home', staging.home], {
    home: staging.home,
  });
  assert.equal(sessions.code, 0, sessions.stderr);
  const rows = JSON.parse(sessions.stdout) as { sessionId: string }[];
  assert.ok(Array.isArray(rows));
  assert.ok(rows.some((row) => row.sessionId === staging.sessionId));

  const missing = await runCli(
    ['result', '--rpc-id', 'no-such-rpc', '--json', '--host', staging.url, '--dsh-home', staging.home],
    { home: staging.home },
  );
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /not in the send index/);
});

test('plain result on a running turn prints nothing; --json still reports pending', { timeout: 90_000 }, async () => {
  // Two steps: the first settles an assistant/message carrying text plus a
  // tool call, then the second model call is held back so the turn stays
  // running with partial text visible in the durable log.
  staging.stub.setHandler((request): StubResponse => {
    if (request.hasToolResult) return { text: 'RUNNING-DONE', delayMs: 8000 };
    return {
      text: 'PARTIAL-TEXT',
      toolCall: {
        name: 'bash',
        args: { command: 'echo partial', description: 'Echo while the turn runs' },
      },
    };
  });
  const sessionId = await staging.createSession();
  const detached = await runCli(
    ['send', 'running-marker', ...args(sessionId), '--detach', '--timeout', '20'],
    { home: staging.home },
  );
  assert.equal(detached.code, 0, detached.stderr);
  const rpcId = detached.stdout.trim();
  await waitForAssistantText(sessionId, 'PARTIAL-TEXT');

  const plain = await runCli(
    ['result', '--rpc-id', rpcId, '--dsh-home', staging.home, '--host', staging.url],
    { home: staging.home },
  );
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.stdout, '', 'plain stdout must carry the final text only, and this turn has none');

  const withJson = await runCli(
    ['result', '--rpc-id', rpcId, '--json', '--dsh-home', staging.home, '--host', staging.url],
    { home: staging.home },
  );
  assert.equal(withJson.code, 0, withJson.stderr);
  const pending = json(withJson);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.text, '');
  assert.equal(pending.partialText, 'PARTIAL-TEXT');
});
