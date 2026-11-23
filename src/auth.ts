/**
 * Browser-cookie minting for the DSH `/api` surface (spec §3.1).
 *
 * DSH's loopback `/api` fence trusts a signed browser cookie. The signing key
 * is the `client-connection/browser-session` grant in `$DSH_HOME/.credentials.yaml`.
 * This module reads that file and mints the exact cookie the Web UI itself
 * would hold; no launch token and no DSH code are involved.
 */

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CredentialsError } from './errors.js';

/** Default cookie lifetime; DSH re-checks the signature, not the UI session. */
export const DEFAULT_COOKIE_TTL_MS = 24 * 60 * 60 * 1000;

const BROWSER_SESSION_RECORD = 'client-connection/browser-session';
const SECRET_KEY = 'secret';

/** Absolute path of the credentials file for a DSH home. */
export function credentialsPath(dshHome: string): string {
  return join(dshHome, '.credentials.yaml');
}

/**
 * Parse the small YAML subset DSH uses for `.credentials.yaml`: nested block
 * mappings of scalars. Sequences and block scalars are rejected loudly rather
 * than silently misread.
 */
export function parseYamlSubset(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: { indent: number; value: Record<string, unknown> }[] = [
    { indent: -1, value: root },
  ];

  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? '';
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (raw.startsWith('\t') || /^ +\t/.test(raw)) {
      throw new CredentialsError(
        `credentials YAML line ${index + 1}: tabs are not supported for indentation`,
      );
    }

    const match = /^( *)([^:]+):(?:[ ](.*))?$/.exec(raw);
    if (match === null) {
      throw new CredentialsError(
        `credentials YAML line ${index + 1}: expected a "key: value" mapping entry`,
      );
    }
    const indent = (match[1] ?? '').length;
    const rawKey = (match[2] ?? '').trim();
    const key = unquote(rawKey);
    let rest = (match[3] ?? '').trim();

    while (stack.length > 1 && indent <= (stack[stack.length - 1]?.indent ?? -1)) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      throw new CredentialsError(`credentials YAML line ${index + 1}: indentation underflow`);
    }
    if (Object.hasOwn(parent.value, key)) {
      throw new CredentialsError(
        `credentials YAML line ${index + 1}: duplicate key "${key}"`,
      );
    }

    if (rest === '' || rest.startsWith('#')) {
      const child: Record<string, unknown> = {};
      parent.value[key] = child;
      stack.push({ indent, value: child });
      continue;
    }
    if (rest.startsWith('|') || rest.startsWith('>')) {
      throw new CredentialsError(
        `credentials YAML line ${index + 1}: block scalars are not supported`,
      );
    }
    if (rest.startsWith('&') || rest.startsWith('*')) {
      throw new CredentialsError(
        `credentials YAML line ${index + 1}: anchors and aliases are not supported`,
      );
    }
    if (!rest.startsWith('"') && !rest.startsWith("'")) {
      const comment = rest.search(/\s#/);
      if (comment !== -1) rest = rest.slice(0, comment).trimEnd();
    }
    parent.value[key] = parseScalar(rest, index + 1);
  }
  return root;
}

function parseScalar(raw: string, line: number): string {
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length === 1) {
      throw new CredentialsError(`credentials YAML line ${line}: unterminated double quote`);
    }
    try {
      return JSON.parse(raw) as string;
    } catch {
      throw new CredentialsError(`credentials YAML line ${line}: invalid double-quoted string`);
    }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length === 1) {
      throw new CredentialsError(`credentials YAML line ${line}: unterminated single quote`);
    }
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      throw new CredentialsError(`credentials YAML: invalid quoted key ${raw}`);
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

/**
 * Read and decode the browser-session signing secret from `$dshHome/.credentials.yaml`.
 * Fails with a message naming the file and the record path when anything is off.
 */
export function loadBrowserSessionSecret(dshHome: string): Buffer {
  const path = credentialsPath(dshHome);
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new CredentialsError(
        `DSH credentials file not found: ${path} (pass --dsh-home <dir> or set DSH_HOME)`,
      );
    }
    throw new CredentialsError(`cannot read DSH credentials file ${path}: ${String(error)}`, {
      cause: error,
    });
  }

  const parsed = parseYamlSubset(source);
  const records = asRecord(parsed.records);
  const record = asRecord(records?.[BROWSER_SESSION_RECORD]);
  if (record === undefined) {
    throw new CredentialsError(
      `credentials file ${path} has no records."${BROWSER_SESSION_RECORD}" grant; ` +
        'start DSH Web once so it mints the browser-session secret',
    );
  }
  const payload = asRecord(record.payload);
  const secret = payload?.[SECRET_KEY];
  if (typeof secret !== 'string' || secret === '') {
    throw new CredentialsError(
      `credentials file ${path}: ${BROWSER_SESSION_RECORD}.payload.secret is missing`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new CredentialsError(
      `credentials file ${path}: ${BROWSER_SESSION_RECORD}.payload.secret is not base64url`,
    );
  }
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== 32) {
    throw new CredentialsError(
      `credentials file ${path}: ${BROWSER_SESSION_RECORD}.payload.secret must decode to ` +
        `32 bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** base64url without padding, per spec §3.1. */
export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Cookie name DSH expects for an authority (`host:port` as addressed). */
export function cookieNameFor(authority: string): string {
  return `dsh-auth-${base64url(createHash('sha256').update(authority, 'utf8').digest())}`;
}

export interface MintCookieOptions {
  secret: Buffer;
  /** `host:port` exactly as the client addresses the host. */
  authority: string;
  now?: number;
  ttlMs?: number;
}

export interface MintedCookie {
  /** Full `name=value` cookie header value. */
  header: string;
  name: string;
  value: string;
}

/**
 * Mint the signed browser cookie:
 * `v1.<base64url(body)>.<base64url(HMAC-SHA256(secret, body))>`, with
 * millisecond `issuedAt`/`expiresAt` inside the body.
 */
export function mintBrowserCookie(options: MintCookieOptions): MintedCookie {
  const { secret, authority } = options;
  if (secret.length !== 32) {
    throw new CredentialsError(`browser-session secret must be 32 bytes, got ${secret.length}`);
  }
  if (!/^[^\s;]+$/.test(authority)) {
    throw new CredentialsError(`invalid authority "${authority}"`);
  }
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_COOKIE_TTL_MS;
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new CredentialsError('invalid cookie timestamps');
  }
  const body = base64url(
    JSON.stringify({
      version: 1,
      authority,
      issuedAt: now,
      expiresAt: now + ttlMs,
    }),
  );
  const signature = createHmac('sha256', secret).update(body, 'utf8').digest();
  const value = `v1.${body}.${base64url(signature)}`;
  const name = cookieNameFor(authority);
  return { header: `${name}=${value}`, name, value };
}
