#!/usr/bin/env node
/**
 * One-command install proof (ticket T3).
 *
 *   1. read-only round trip against the live DSH host: auth, discovery, session/list
 *   2. full send round trip against a disposable staging instance with a stub
 *      provider — no real model call, no real user session touched
 *
 * Usage: node scripts/verify.mjs
 * Requires `npm run build` and `npm run build:tests` (both run by `npm test`).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'dist', 'client.js');
const CLI = join(ROOT, 'dist', 'cli.js');
const STAGING = join(ROOT, 'dist-test', 'tests', 'staging.js');

function fail(message, hint) {
  console.error(`\nverify: ${message}`);
  if (hint !== undefined) console.error(`        ${hint}`);
  process.exit(1);
}

function step(title) {
  console.log(`\n── ${title}`);
}

for (const [path, hint] of [
  [CORE, 'run `npm run build`'],
  [CLI, 'run `npm run build`'],
  [STAGING, 'run `npm run build:tests`'],
]) {
  if (!existsSync(path)) fail(`missing ${path}`, hint);
}

const { SessionClient } = await import(CORE);
const { startStaging, runCli } = await import(STAGING);

// ── 1. live read-only ──────────────────────────────────────────────────────
step('live host: auth + discovery + session/list (read-only)');
let liveRows;
try {
  const client = await SessionClient.connect({
    onDiscoveryNote: note => console.log(`   discovery: ${note}`),
  });
  console.log(`   host: ${client.endpoint.origin}`);
  liveRows = await client.listSessions();
  console.log(`   sessions: ${liveRows.length}`);
  for (const row of liveRows.slice(0, 3)) {
    const title = row.projections?.values?.title ?? '';
    console.log(`   ${row.sessionId}  running=${String(row.running)}  ${title}`);
  }
} catch (error) {
  fail(
    `live host check failed: ${error?.message ?? String(error)}`,
    'pass --host via DSH_BRIDGE_HOST, or restart DSH if credentials rotated (401)',
  );
}

// ── 2. staging round trip ──────────────────────────────────────────────────
step('staging instance: send round trip (stub provider, no real model call)');
const staging = await startStaging();
try {
  staging.stub.setHandler(request =>
    request.lastHumanText.includes('verify-marker')
      ? { text: 'VERIFY-PONG' }
      : { text: 'unexpected' });

  const sessionId = await staging.createSession();
  console.log(`   host: ${staging.url}`);
  console.log(`   session: ${sessionId}`);

  const sent = await runCli(
    ['send', 'verify-marker', '--session', sessionId, '--from', 'verify', '--timeout', '30'],
    { home: staging.home },
  );
  if (sent.code !== 0) fail(`staging send exited ${sent.code}: ${sent.stderr.trim()}`);
  const text = sent.stdout.trim();
  console.log(`   stdout: ${JSON.stringify(text)}`);
  if (text !== 'VERIFY-PONG') fail(`unexpected assistant text ${JSON.stringify(text)}`);

  const detached = await runCli(
    ['send', 'verify-marker-detached', '--session', sessionId, '--detach'],
    { home: staging.home },
  );
  if (detached.code !== 0) fail(`detach exited ${detached.code}: ${detached.stderr.trim()}`);
  const rpcId = detached.stdout.trim();
  console.log(`   detached rpcId: ${rpcId}`);

  const readBack = await runCli(['result', '--rpc-id', rpcId, '--wait', '--timeout', '30', '--json'], {
    home: staging.home,
  });
  if (readBack.code !== 0) fail(`result exited ${readBack.code}: ${readBack.stderr.trim()}`);
  const verdict = JSON.parse(readBack.stdout);
  console.log(`   result: status=${verdict.status} turn=${verdict.turn} toolCalls=${verdict.toolCalls.length}`);
  if (verdict.status !== 'completed') fail(`result status ${verdict.status} is not completed`);
} finally {
  await staging.stop();
}

console.log(`\nverify: OK — live auth/list works (${liveRows.length} sessions) and a staging send returned its own turn's answer.`);
