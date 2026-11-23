/**
 * URL-token authentication (release contract: "Authentication — two paths, automatic").
 *
 * `dsh web` prints `http://127.0.0.1:<port>/?token=…`. A single `GET` of that
 * URL answers `303` with the signed browser cookie DSH's own Web UI holds; no
 * launch token exists anywhere else and no DSH internals are involved. The
 * exchange is deliberately narrow:
 *
 * - redirects are never followed (`redirect: 'manual'`), so the token cannot be
 *   bounced to another authority;
 * - only `303` + `Set-Cookie` is accepted — anything else is a named failure,
 *   never a fallback;
 * - the cookie is the `name=value` pair before the first `;`, used for exactly
 *   the origin the token came from, and held in memory only.
 *
 * No function here logs, formats, or rethrows the token; the one string that
 * may be printed (`redactUrl`) masks the `token` query value.
 */

import { HostError, ProtocolError } from './errors.js';

/** The exchange is one request to an already-running local or remote host. */
export const DEFAULT_EXCHANGE_TIMEOUT_MS = 10_000;

/** The masked form of a `?token=` value. */
const REDACTED = '…';

/** How an input is named in messages: `--url`, `DSH_BRIDGE_URL`, or the config file. */
export type UrlTokenSource = string;

export interface LaunchUrl {
  /** The URL exactly as supplied; this is what gets fetched once. */
  readonly url: URL;
  /** The `token` query value. Never print or serialize it. */
  readonly token: string;
  /** `http(s)://host:port`; the only authority the resulting cookie is used with. */
  readonly origin: string;
}

export interface UrlTokenCookie {
  /** Same origin as the launch URL. */
  readonly origin: string;
  /** `name=value`, exactly what the `Cookie` header should carry. */
  readonly cookie: string;
  /** Cookie name only (diagnostics; never the value). */
  readonly cookieName: string;
}

/**
 * True when a URL string carries a non-empty `token` query parameter.
 * Used to decide whether the config file's `url` means "exchange a token" or
 * merely "use this origin".
 */
export function hasUrlToken(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return false;
  }
  const token = url.searchParams.get('token');
  return token !== null && token !== '';
}

/**
 * Validate an explicit URL-token input (`--url`, `DSH_BRIDGE_URL`) and pull out
 * its token. Every failure names the source and never echoes the value.
 */
export function parseLaunchUrl(input: string, source: UrlTokenSource): LaunchUrl {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new HostError(
      `${source} is empty; expected the URL dsh web printed, ` +
        'e.g. http://127.0.0.1:<port>/?token=<token>',
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HostError(
      `${source} is not a valid absolute URL; expected the URL dsh web printed, ` +
        'e.g. http://127.0.0.1:<port>/?token=<token>',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HostError(
      `${source} must be an http(s) URL, got protocol "${url.protocol}"`,
    );
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new HostError(
      `${source} must be the DSH Web root URL (…/?token=…); ` +
        `got a URL with path "${url.pathname}"`,
    );
  }
  const token = url.searchParams.get('token');
  if (token === null || token === '') {
    throw new HostError(
      `${source} has no ?token= value. Use the full URL dsh web printed ` +
        '(…/?token=…), or use --host / DSH_BRIDGE_HOST / the config "host" key ' +
        'for a plain origin.',
    );
  }
  return { url, token, origin: url.origin };
}

/**
 * Mask a URL's `token` query value for printing. Never returns the token, even
 * for input that does not parse as a URL.
 */
export function redactUrl(input: string | URL): string {
  const raw = typeof input === 'string' ? input : input.href;
  return raw.replace(/([?&]token=)[^&#\s]*/gi, `$1${REDACTED}`);
}

export interface ExchangeOptions {
  /** Names the input in error messages (`--url`, `DSH_BRIDGE_URL`, the config file). */
  source?: UrlTokenSource;
  /** Test seam; production uses global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Exchange a launch URL for DSH's browser cookie.
 *
 * Accepts exactly `303` with a `Set-Cookie` header. Any other status, a
 * redirect, a missing cookie, or a transport failure is an error that names
 * the expected result and the concrete fix — there is no second attempt and no
 * fallback to credential minting, so a broken token stays visible.
 */
export async function exchangeUrlToken(
  launch: LaunchUrl,
  options: ExchangeOptions = {},
): Promise<UrlTokenCookie> {
  const label = options.source ?? 'the launch URL';
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(launch.url.href, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new HostError(
        `timed out after ${String(timeoutMs)} ms exchanging the URL token with ` +
          `${launch.origin} (${redactUrl(launch.url)})`,
        { cause: error },
      );
    }
    throw new HostError(
      `cannot reach DSH at ${launch.origin} to exchange the URL token from ${label}: ` +
        `${(error as Error).message}`,
      { cause: error },
    );
  }

  const status = response.status;
  const setCookieHeader = readSetCookie(response);
  discardBody(response);

  if (status !== 303) {
    throw new ProtocolError(
      `URL-token exchange with ${launch.origin} returned HTTP ${String(status)}; ` +
        'expected 303 with Set-Cookie (DSH\'s launch flow). ' +
        `The URL came from ${label} (${redactUrl(launch.url)}). ` +
        'Copy the URL that dsh web printed for the running instance and retry.',
    );
  }
  if (setCookieHeader === undefined) {
    throw new ProtocolError(
      `URL-token exchange with ${launch.origin} returned HTTP 303 but no Set-Cookie header; ` +
        'expected 303 with Set-Cookie. DSH did not hand out a browser cookie: ' +
        'check that the token belongs to the running instance.',
    );
  }

  const pair = (setCookieHeader.split(';', 1)[0] ?? '').trim();
  const eq = pair.indexOf('=');
  const name = eq > 0 ? pair.slice(0, eq) : '';
  if (name === '' || /[\s;]/.test(pair)) {
    throw new ProtocolError(
      `URL-token exchange with ${launch.origin} returned a Set-Cookie value that is not a ` +
        '`name=value` pair',
    );
  }
  return { origin: launch.origin, cookie: pair, cookieName: name };
}

/** First `Set-Cookie` value, using `getSetCookie()` when the runtime offers it. */
function readSetCookie(response: Response): string | undefined {
  const getSetCookie = (response.headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') {
    const values = getSetCookie.call(response.headers);
    if (values.length > 0) return values[0];
  }
  return response.headers.get('set-cookie') ?? undefined;
}

/** Release the (small) 303 body without ever printing it. */
function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Already consumed or locked; nothing to release.
  }
}
