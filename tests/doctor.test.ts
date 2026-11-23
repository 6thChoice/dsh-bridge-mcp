/**
 * `dsh-bridge doctor` (release contract: "New commands").
 *
 * All checks run against local `node:http` servers that speak the two wire
 * facts doctor needs: an unauthenticated `GET /` (any HTTP response proves
 * reachability) and `POST /api/session/list` with a `server-response` envelope.
 * No staging instance and no real DSH host are involved.
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderDoctor, runDoctor } from '../src/doctor.js';

const SECRET_BYTES = Buffer.alloc(32, 7);
const SECRET = SECRET_BYTES.toString('base64url');
const URL_TOKEN = 'good-token';

interface FakeDsh {
  origin: string;
  authority: string;
  close: () => Promise<void>;
}

interface FakeDshOptions {
  /** When true, POST /api/session/list only accepts a signed `dsh-auth-*` cookie. */
  requireAuthCookie?: boolean;
  /** Always answer 401 to the API, to model a rejected cookie. */
  always401?: boolean;
  sessions?: number;
}

async function fakeDsh(options: FakeDshOptions = {}): Promise<FakeDsh> {
  const sessions = options.sessions ?? 3;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET') {
        if (url.pathname === '/' && url.searchParams.get('token') === URL_TOKEN) {
          response.writeHead(303, {
            'set-cookie': 'dsh-auth-url-token=v1.body.sig; Path=/; HttpOnly',
            location: '/',
          });
          response.end();
          return;
        }
        // Unauthenticated `/` is 401, like the real host.
        response.writeHead(401);
        response.end('unauthorized');
        return;
      }
      const cookie = request.headers.cookie ?? '';
      // A minted cookie embeds its own issue time, so check the signed shape
      // rather than a second mint of "the same" cookie.
      const signed = /^dsh-auth-[^=]+=v1\.[^.]*\.[^.]*$/.test(cookie);
      const rejected =
        options.always401 === true || (options.requireAuthCookie === true && !signed);
      if (rejected) {
        response.writeHead(401);
        response.end('denied');
        return;
      }
      let rpcId = '';
      try {
        rpcId = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rpcId?: string }).rpcId ?? '';
      } catch {
        rpcId = '';
      }
      const items = Array.from({ length: sessions }, (_, index) => ({
        sessionId: `session-${String(index)}`,
        updatedAt: index,
        running: false,
      }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { items } } }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const authority = `127.0.0.1:${String(address.port)}`;
  return {
    origin: `http://${authority}`,
    authority,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

function makeCredentialHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-doctor-'));
  writeFileSync(
    join(home, '.credentials.yaml'),
    `version: 1
records:
  client-connection/browser-session:
    payload:
      secret: ${SECRET}
`,
    'utf8',
  );
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function optionsFor(origin: string, dshHome: string) {
  return {
    host: origin,
    dshHome,
    homeDir: dshHome,
    configPath: join(dshHome, 'no-config.json'),
    env: {} as NodeJS.ProcessEnv,
    timeoutMs: 5_000,
  };
}

function assertNoSecrets(text: string): void {
  assert.ok(!text.includes(SECRET), 'the signing secret must never be printed');
  assert.ok(!text.includes('v1.body.sig'), 'the cookie value must never be printed');
  assert.ok(!text.includes(URL_TOKEN), 'the URL token must never be printed');
}

/* ------------------------------------------------------------------ checks */

test('credentials path: accepted probe, visible count, stable fields', async () => {
  const fake = await fakeDsh({ sessions: 2, requireAuthCookie: true });
  const fixture = makeCredentialHome();
  try {
    const report = await runDoctor(optionsFor(fake.origin, fixture.home));
    assert.equal(report.ok, true);
    assert.equal(report.host, fake.origin);
    assert.equal(report.hostSource, 'flag');
    assert.equal(report.authPath, 'credentials');
    assert.equal(report.authSource, 'credentials');
    assert.equal(report.credentialsAvailable, true);
    assert.equal(report.probe.status, 'accepted');
    assert.equal(report.sessionCount, 2);
    assert.deepEqual(
      report.checks.map((check) => check.name),
      ['host', 'auth', 'reachability', 'session/list', 'sessions'],
    );
    assert.ok(report.checks.every((check) => check.ok));
    assert.equal(typeof report.reachability.latencyMs, 'number');
    assert.equal(typeof report.probe.latencyMs, 'number');
    assert.equal(report.reachability.ok, true);
    assert.match(report.reachability.detail, /HTTP 401/);
    assert.match(report.reachability.detail, /reachable/);

    const text = renderDoctor(report);
    assertNoSecrets(text);
    assert.match(text, /ok — the bridge can send/);
    assert.match(text, /2 visible/);

    const json = JSON.stringify(report);
    assertNoSecrets(json);
    assert.deepEqual(Object.keys(report).sort(), [
      'authPath',
      'authSource',
      'checks',
      'credentialsAvailable',
      'host',
      'hostSource',
      'ok',
      'probe',
      'reachability',
      'sessionCount',
    ]);
  } finally {
    fixture.cleanup();
    await fake.close();
  }
});

test('denied: the probe is named, the fix is concrete, and ok is false', async () => {
  const fake = await fakeDsh({ always401: true });
  const fixture = makeCredentialHome();
  try {
    const report = await runDoctor(optionsFor(fake.origin, fixture.home));
    assert.equal(report.ok, false);
    assert.equal(report.probe.status, 'denied');
    assert.equal(report.sessionCount, 0);
    const probe = report.checks.find((check) => check.name === 'session/list');
    assert.equal(probe?.ok, false);
    assert.match(probe?.detail ?? '', /denied/);
    assert.match(probe?.nextStep ?? '', /restart DSH|copy the URL/);
    const sessionsCheck = report.checks.find((check) => check.name === 'sessions');
    assert.equal(sessionsCheck?.ok, false);
    const text = renderDoctor(report);
    assertNoSecrets(text);
    assert.match(text, /FAIL {2}session\/list/);
    assert.match(text, /next:/);
  } finally {
    fixture.cleanup();
    await fake.close();
  }
});

test('unreachable: reachability fails before the probe and names DSH', async () => {
  const fake = await fakeDsh();
  const origin = fake.origin;
  await fake.close(); // nothing listens on that port any more
  const fixture = makeCredentialHome();
  try {
    const report = await runDoctor({ ...optionsFor(origin, fixture.home), timeoutMs: 2_000 });
    assert.equal(report.ok, false);
    assert.equal(report.reachability.ok, false);
    assert.equal(report.probe.status, 'unreachable');
    const reachability = report.checks.find((check) => check.name === 'reachability');
    assert.equal(reachability?.ok, false);
    assert.match(reachability?.nextStep ?? '', /Start DSH Web/);
    const text = renderDoctor(report);
    assertNoSecrets(text);
    assert.match(text, /FAIL {2}reachability/);
  } finally {
    fixture.cleanup();
  }
});

test('url-token path: authenticated with no credentials file, and reported as such', async () => {
  const fake = await fakeDsh({ sessions: 4 });
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-doctor-token-'));
  try {
    const dshHome = join(home, 'no-such-home');
    const report = await runDoctor({
      url: `${fake.origin}/?token=${URL_TOKEN}`,
      dshHome,
      homeDir: home,
      configPath: join(home, 'no-config.json'),
      env: {},
      timeoutMs: 5_000,
    });
    assert.equal(report.ok, true);
    assert.equal(report.authPath, 'url-token');
    assert.equal(report.authSource, 'flag');
    assert.equal(report.hostSource, 'url');
    assert.equal(report.credentialsAvailable, false);
    assert.equal(report.sessionCount, 4);
    assert.equal(report.probe.status, 'accepted');

    const text = renderDoctor(report);
    assertNoSecrets(text);
    assert.match(text, /url-token/);
    assert.match(text, /2 visible|4 visible/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    await fake.close();
  }
});

test('both paths configured: the URL wins and doctor says so', async () => {
  const fake = await fakeDsh({ sessions: 1 });
  const fixture = makeCredentialHome();
  try {
    const report = await runDoctor({
      ...optionsFor(fake.origin, fixture.home),
      host: undefined,
      url: `${fake.origin}/?token=${URL_TOKEN}`,
    });
    assert.equal(report.ok, true);
    assert.equal(report.authPath, 'url-token');
    assert.equal(report.credentialsAvailable, true);
    const auth = report.checks.find((check) => check.name === 'auth');
    assert.match(auth?.detail ?? '', /credential record also exists/);
    assert.match(renderDoctor(report), /the URL token wins/);
  } finally {
    fixture.cleanup();
    await fake.close();
  }
});

test('a failed URL exchange is reported as the auth failure (no credential fallback)', async () => {
  const fake = await fakeDsh();
  const fixture = makeCredentialHome();
  try {
    const report = await runDoctor({
      ...optionsFor(fake.origin, fixture.home),
      host: undefined,
      url: `${fake.origin}/?token=wrong-token`,
    });
    assert.equal(report.ok, false);
    assert.equal(report.host, null);
    assert.equal(report.authPath, null);
    const host = report.checks.find((check) => check.name === 'host');
    assert.equal(host?.ok, false);
    assert.match(host?.detail ?? '', /HTTP 401/);
    assert.match(host?.nextStep ?? '', /dsh web|DSH_BRIDGE_URL/);
    const text = renderDoctor(report);
    assertNoSecrets(text);
    assert.match(text, /FAIL {2}host/);
  } finally {
    fixture.cleanup();
    await fake.close();
  }
});

test('no host at all: every check fails with a next step, and nothing throws', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-doctor-none-'));
  try {
    const report = await runDoctor({
      dshHome: join(home, 'nope'),
      homeDir: home,
      configPath: join(home, 'no-config.json'),
      env: {},
      platform: 'freebsd',
      probes: [],
      timeoutMs: 2_000,
    });
    assert.equal(report.ok, false);
    assert.equal(report.host, null);
    assert.equal(report.sessionCount, 0);
    assert.equal(report.checks.filter((check) => check.ok).length, 0);
    assert.match(report.checks[0]?.nextStep ?? '', /dsh web/);
    const text = renderDoctor(report);
    assert.match(text, /FAIL {2}host/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
