import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  cookieNameFor,
  credentialsPath,
  loadBrowserSessionSecret,
  mintBrowserCookie,
  parseYamlSubset,
} from '../src/auth.js';
import { CredentialsError } from '../src/errors.js';

const SECRET_BYTES = Buffer.alloc(32, 7);
const SECRET = SECRET_BYTES.toString('base64url');

function homeWith(source: string): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-auth-'));
  writeFileSync(join(home, '.credentials.yaml'), source, 'utf8');
  return {
    home,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function credentials(secret = SECRET): string {
  return `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: ${secret}
`;
}

test('reads the browser-session secret from a DSH credentials file', () => {
  const fixture = homeWith(credentials());
  try {
    assert.deepEqual(loadBrowserSessionSecret(fixture.home), SECRET_BYTES);
  } finally {
    fixture.cleanup();
  }
});

test('missing credentials file names the expected path', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-auth-'));
  try {
    assert.throws(
      () => loadBrowserSessionSecret(home),
      (error: unknown) =>
        error instanceof CredentialsError &&
        error.message.includes(credentialsPath(home)) &&
        error.message.includes('not found'),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('missing browser-session record fails loudly', () => {
  const fixture = homeWith('version: 1\nrecords:\n  other/key:\n    payload:\n      secret: x\n');
  try {
    assert.throws(
      () => loadBrowserSessionSecret(fixture.home),
      (error: unknown) =>
        error instanceof CredentialsError &&
        error.message.includes('client-connection/browser-session'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('secret must decode to exactly 32 bytes', () => {
  const fixture = homeWith(credentials(Buffer.alloc(16, 1).toString('base64url')));
  try {
    assert.throws(
      () => loadBrowserSessionSecret(fixture.home),
      (error: unknown) =>
        error instanceof CredentialsError && error.message.includes('32 bytes'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('non-base64url secret is rejected before hashing', () => {
  const fixture = homeWith(credentials('not a base64 secret!'));
  try {
    assert.throws(
      () => loadBrowserSessionSecret(fixture.home),
      (error: unknown) =>
        error instanceof CredentialsError && error.message.includes('base64url'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('YAML subset supports quoting and comments', () => {
  const parsed = parseYamlSubset(`# top
version: 1
records:
  "client-connection/browser-session":
    kind: grant   # inline
    payload:
      version: 1
      secret: '${SECRET}'
`);
  const records = parsed.records as Record<string, unknown>;
  const record = records['client-connection/browser-session'] as Record<string, unknown>;
  const payload = record.payload as Record<string, unknown>;
  assert.equal(payload.secret, SECRET);
  assert.equal(record.kind, 'grant');
});

test('YAML subset rejects duplicates, tabs, and block scalars', () => {
  assert.throws(() => parseYamlSubset('a: 1\na: 2\n'), /duplicate key/);
  assert.throws(() => parseYamlSubset('\ta: 1\n'), /tabs/);
  assert.throws(() => parseYamlSubset('a: |\n  body\n'), /block scalars/);
});

test('mints the spec cookie: name hash, body shape, HMAC signature', () => {
  const authority = '127.0.0.1:49904';
  const now = 1_700_000_000_000;
  const minted = mintBrowserCookie({ secret: SECRET_BYTES, authority, now, ttlMs: 5_000 });
  assert.equal(minted.name, cookieNameFor(authority));
  assert.equal(minted.header, `${minted.name}=${minted.value}`);

  const parts = minted.value.split('.');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'v1');
  const body = parts[1] ?? '';
  const signature = parts[2] ?? '';
  assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), {
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + 5_000,
  });
  const expected = createHmac('sha256', SECRET_BYTES).update(body, 'utf8').digest('base64url');
  assert.equal(signature, expected);
});

test('cookie name is a function of the authority', () => {
  assert.equal(cookieNameFor('127.0.0.1:49904'), cookieNameFor('127.0.0.1:49904'));
  assert.notEqual(cookieNameFor('127.0.0.1:49904'), cookieNameFor('localhost:49904'));
  assert.match(cookieNameFor('127.0.0.1:49904'), /^dsh-auth-[A-Za-z0-9_-]+$/);
});

test('mint rejects a short secret and empty authority', () => {
  assert.throws(
    () => mintBrowserCookie({ secret: Buffer.alloc(1), authority: '127.0.0.1:1' }),
    /32 bytes/,
  );
  assert.throws(() => mintBrowserCookie({ secret: SECRET_BYTES, authority: '' }), /authority/);
});
