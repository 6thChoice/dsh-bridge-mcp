/**
 * URL-token authentication: the exchange itself and its precedence inside
 * `resolveHost` (release contract: "Authentication — two paths, automatic").
 *
 * Everything here runs against local `node:http` servers or an injected fetch:
 * no staging instance, no real DSH, no credentials value in any assertion
 * output.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveHost } from '../src/host.js';
import { ConfigError, HostError, ProtocolError } from '../src/errors.js';
import {
  exchangeUrlToken,
  hasUrlToken,
  parseLaunchUrl,
  redactUrl,
} from '../src/urltoken.js';

const TOKEN = 'sekret-token-value';

function launchUrl(origin: string, token = TOKEN): string {
  return `${origin}/?token=${token}`;
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

const SECRET = Buffer.alloc(32, 5).toString('base64url');

function makeCredentialHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-urltoken-'));
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

function fake303(cookie = 'dsh-auth-test=v1.body.sig'): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(null, {
        status: 303,
        headers: { 'set-cookie': `${cookie}; Path=/; HttpOnly; SameSite=Lax` },
      }),
    );
}

/* ------------------------------------------------------------- parsing */

test('parseLaunchUrl keeps the token and reduces the URL to its origin', () => {
  const parsed = parseLaunchUrl(launchUrl('http://127.0.0.1:49904'), '--url');
  assert.equal(parsed.token, TOKEN);
  assert.equal(parsed.origin, 'http://127.0.0.1:49904');
  // The URL object keeps the full launch URL for the one GET.
  assert.equal(parsed.url.searchParams.get('token'), TOKEN);
});

test('parseLaunchUrl rejects everything that is not a launch URL, without echoing the token', () => {
  const cases: [string, RegExp][] = [
    ['', /empty/],
    ['not a url?token=sekret', /not a valid absolute URL/],
    ['ftp://127.0.0.1:1/?token=sekret', /http\(s\)/],
    ['http://127.0.0.1:49904/api?token=sekret', /root URL/],
    ['http://127.0.0.1:49904/', /no \?token=/],
    ['http://127.0.0.1:49904/?token=', /no \?token=/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(
      () => parseLaunchUrl(input, '--url'),
      (error: unknown) =>
        error instanceof HostError &&
        pattern.test(error.message) &&
        !error.message.includes('sekret'),
      `input ${JSON.stringify(input)}`,
    );
  }
});

test('hasUrlToken only reports a non-empty token query value', () => {
  assert.equal(hasUrlToken(launchUrl('http://127.0.0.1:1')), true);
  assert.equal(hasUrlToken('http://127.0.0.1:1/?token='), false);
  assert.equal(hasUrlToken('http://127.0.0.1:1/?other=1'), false);
  assert.equal(hasUrlToken('http://127.0.0.1:1/'), false);
  assert.equal(hasUrlToken('not a url'), false);
});

test('redactUrl masks the token and never leaks it, even from garbage input', () => {
  assert.equal(
    redactUrl('http://127.0.0.1:49904/?token=abcdef&x=1'),
    'http://127.0.0.1:49904/?token=…&x=1',
  );
  assert.equal(
    redactUrl('http://127.0.0.1:49904/?TOKEN=abcdef'),
    'http://127.0.0.1:49904/?TOKEN=…',
  );
  assert.equal(redactUrl('not a url?token=abcdef'), 'not a url?token=…');
  assert.equal(redactUrl(new URL('http://h/?token=abcdef')), 'http://h/?token=…');
});

/* ------------------------------------------------------------ exchange */

test('exchangeUrlToken accepts exactly 303 + Set-Cookie and keeps name=value only', async () => {
  let seen: { href: string; redirect: string | undefined } | undefined;
  const fetchImpl: typeof fetch = (input, init) => {
    seen = { href: String(input), redirect: init?.redirect };
    return Promise.resolve(
      new Response(null, {
        status: 303,
        headers: {
          'set-cookie': 'dsh-auth-abc=v1.body.sig; Path=/; HttpOnly; SameSite=Lax',
        },
      }),
    );
  };
  const parsed = parseLaunchUrl(launchUrl('http://127.0.0.1:49904'), '--url');
  const cookie = await exchangeUrlToken(parsed, { source: '--url', fetchImpl });
  assert.equal(cookie.cookie, 'dsh-auth-abc=v1.body.sig');
  assert.equal(cookie.cookieName, 'dsh-auth-abc');
  assert.equal(cookie.origin, 'http://127.0.0.1:49904');
  assert.equal(seen?.href, launchUrl('http://127.0.0.1:49904'));
  assert.equal(seen?.redirect, 'manual');
  assert.ok(seen !== undefined);
});

test('exchangeUrlToken reports a non-303 status with the status, the expectation, and no token', async () => {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(new Response('nope', { status: 200, headers: { 'content-type': 'text/html' } }));
  const parsed = parseLaunchUrl(launchUrl('http://127.0.0.1:49904'), '--url');
  await assert.rejects(
    exchangeUrlToken(parsed, { source: '--url', fetchImpl }),
    (error: unknown) =>
      error instanceof ProtocolError &&
      error.message.includes('HTTP 200') &&
      error.message.includes('expected 303') &&
      !error.message.includes(TOKEN),
  );
});

test('exchangeUrlToken reports a redirect and a missing Set-Cookie separately', async () => {
  const parsed = parseLaunchUrl(launchUrl('http://127.0.0.1:49904'), '--url');
  for (const [status, headers, pattern] of [
    [302, { location: 'http://elsewhere/' }, /HTTP 302/],
    [303, {}, /no Set-Cookie/],
  ] as const) {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response(null, { status, headers }));
    await assert.rejects(
      exchangeUrlToken(parsed, { source: '--url', fetchImpl }),
      (error: unknown) =>
        error instanceof ProtocolError && pattern.test(error.message),
    );
  }
});

test('exchangeUrlToken rejects a Set-Cookie that is not a name=value pair', async () => {
  const parsed = parseLaunchUrl(launchUrl('http://127.0.0.1:49904'), '--url');
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(null, { status: 303, headers: { 'set-cookie': 'novalue; Path=/' } }),
    );
  await assert.rejects(
    exchangeUrlToken(parsed, { source: '--url', fetchImpl }),
    (error: unknown) => error instanceof ProtocolError && error.message.includes('name=value'),
  );
});

test('exchangeUrlToken turns a transport failure into a named HostError', async () => {
  const parsed = parseLaunchUrl(launchUrl('http://127.0.0.1:49904'), '--url');
  const fetchImpl: typeof fetch = () => Promise.reject(new Error('connect ECONNREFUSED'));
  await assert.rejects(
    exchangeUrlToken(parsed, { source: '--url', fetchImpl }),
    (error: unknown) =>
      error instanceof HostError &&
      error.message.includes('cannot reach DSH at http://127.0.0.1:49904') &&
      !error.message.includes(TOKEN),
  );
});

/* ------------------------------------------------- precedence in resolveHost */

test('--url wins over credentials and needs no credentials file at all', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-urltoken-empty-'));
  try {
    const resolved = await resolveHost({
      url: launchUrl('http://127.0.0.1:49904'),
      dshHome: join(home, 'does-not-exist'),
      homeDir: home,
      configPath: join(home, 'no-config.json'),
      env: {},
      fetchImpl: fake303(),
    });
    assert.equal(resolved.authPath, 'url-token');
    assert.equal(resolved.authSource, 'flag');
    assert.equal(resolved.source, 'url');
    assert.equal(resolved.endpoint.origin, 'http://127.0.0.1:49904');
    assert.equal(resolved.cookie, 'dsh-auth-test=v1.body.sig');
    assert.equal(resolved.credentialsAvailable, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--url wins when both paths are configured and says so', async () => {
  const fixture = makeCredentialHome();
  try {
    const resolved = await resolveHost({
      url: launchUrl('http://127.0.0.1:49904'),
      dshHome: fixture.home,
      homeDir: fixture.home,
      configPath: join(fixture.home, 'no-config.json'),
      env: {},
      fetchImpl: fake303(),
    });
    assert.equal(resolved.authPath, 'url-token');
    assert.equal(resolved.credentialsAvailable, true);
    assert.equal(resolved.cookie, 'dsh-auth-test=v1.body.sig');
  } finally {
    fixture.cleanup();
  }
});

test('DSH_BRIDGE_URL is the second URL rung', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-urltoken-env-'));
  try {
    const resolved = await resolveHost({
      dshHome: join(home, 'nope'),
      homeDir: home,
      configPath: join(home, 'no-config.json'),
      env: { DSH_BRIDGE_URL: launchUrl('http://127.0.0.1:49904') },
      fetchImpl: fake303(),
    });
    assert.equal(resolved.authPath, 'url-token');
    assert.equal(resolved.authSource, 'env');
    assert.equal(resolved.source, 'url-env');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a failed URL exchange never falls back to credentials', async () => {
  const fixture = makeCredentialHome();
  try {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response('bad token', { status: 403 }));
    await assert.rejects(
      resolveHost({
        url: launchUrl('http://127.0.0.1:49904'),
        dshHome: fixture.home,
        homeDir: fixture.home,
        configPath: join(fixture.home, 'no-config.json'),
        env: {},
        fetchImpl,
      }),
      (error: unknown) =>
        error instanceof ProtocolError &&
        error.message.includes('HTTP 403') &&
        error.message.includes('expected 303') &&
        // A credentials fallback would have produced a cookie and resolved.
        !error.message.includes(SECRET),
    );
  } finally {
    fixture.cleanup();
  }
});

test('--url and --host must name the same origin, and the error carries no token', async () => {
  await assert.rejects(
    resolveHost({
      url: launchUrl('http://127.0.0.1:49904'),
      host: 'http://127.0.0.1:50000',
      env: {},
      fetchImpl: fake303(),
    }),
    (error: unknown) =>
      error instanceof HostError &&
      error.message.includes('http://127.0.0.1:49904') &&
      error.message.includes('http://127.0.0.1:50000') &&
      !error.message.includes(TOKEN),
  );
});

test('the config file url token is used, and its failure names the config file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-urltoken-config-'));
  try {
    const configPath = join(home, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ url: launchUrl('http://127.0.0.1:49904') }),
      'utf8',
    );
    const resolved = await resolveHost({
      dshHome: join(home, 'nope'),
      homeDir: home,
      configPath,
      env: {},
      fetchImpl: fake303('dsh-auth-cfg=v1.x.y'),
    });
    assert.equal(resolved.authPath, 'url-token');
    assert.equal(resolved.authSource, 'config');
    assert.equal(resolved.source, 'config-url');
    assert.equal(resolved.cookie, 'dsh-auth-cfg=v1.x.y');

    const fetchImpl: typeof fetch = () => Promise.resolve(new Response('', { status: 500 }));
    await assert.rejects(
      resolveHost({ dshHome: join(home, 'nope'), homeDir: home, configPath, env: {}, fetchImpl }),
      (error: unknown) =>
        error instanceof ProtocolError &&
        error.message.includes('HTTP 500') &&
        error.message.includes(configPath) &&
        !error.message.includes(TOKEN),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the config url without a token keeps the credentials path and its origin', async () => {
  const fixture = makeCredentialHome();
  try {
    const configPath = join(fixture.home, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        url: 'http://127.0.0.1:4444/',
        host: 'http://127.0.0.1:5555',
      }),
      'utf8',
    );
    const resolved = await resolveHost({
      dshHome: fixture.home,
      homeDir: fixture.home,
      configPath,
      env: {},
    });
    assert.equal(resolved.source, 'config-url');
    assert.equal(resolved.authPath, 'credentials');
    assert.equal(resolved.endpoint.origin, 'http://127.0.0.1:4444');
  } finally {
    fixture.cleanup();
  }
});

test('a config url with a token but a bad shape is a ConfigError naming the file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-urltoken-bad-'));
  try {
    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({ url: 'http://127.0.0.1:1/api?token=sekret' }), 'utf8');
    await assert.rejects(
      resolveHost({ dshHome: join(home, 'nope'), homeDir: home, configPath, env: {} }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes(configPath) &&
        error.message.includes('root URL') &&
        !error.message.includes('sekret'),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
