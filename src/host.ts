/**
 * Host addressing, discovery, and the unary `/api` RPC helper (spec §3.2, §9).
 *
 * A host is identified by its origin. `RpcTransport` wraps exactly one
 * `client-request` envelope per call and turns every failure mode into a
 * message that names the host, endpoint, and HTTP status.
 *
 * Host and auth resolution order (release contract):
 *
 * 1. `--url` → `DSH_BRIDGE_URL` (the launch URL `dsh web` prints). Its token is
 *    exchanged for DSH's browser cookie; this path wins over everything below.
 * 2. `--host` → `DSH_BRIDGE_HOST` → the optional config file → platform
 *    discovery, with the cookie minted from `$DSH_HOME/.credentials.yaml`.
 *
 * The config file's `url` participates at its own rung: with a `?token=` it is
 * the URL-token path, without one it contributes its origin like `host` does.
 * A configured URL token that fails is reported as a failure — it never falls
 * back to credential minting, so a broken token stays visible.
 *
 * Discovery probes are platform-specific; each candidate must pass an
 * authenticated `session/list` before it is accepted.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ConfigError, CredentialsError, HostError, ProtocolError, RpcError } from './errors.js';
import { loadBrowserSessionSecret, mintBrowserCookie } from './auth.js';
import { exchangeUrlToken, hasUrlToken, parseLaunchUrl } from './urltoken.js';
import { homedir, userInfo } from 'node:os';
import { type LoadedConfig, loadConfig, resolveDshHome } from './config.js';

/** Default unary-call budget. `session/list` on a busy host is fast. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Which front end is resolving the host; only error hints differ. */
export type CallerKind = 'cli' | 'mcp';

/** How the cookie was obtained (release contract: two paths, automatic). */
export type AuthPath = 'url-token' | 'credentials';

/** Which input supplied the URL token or the credential secret. */
export type AuthSource = 'flag' | 'env' | 'config' | 'credentials';

/** An addressed DSH Web origin. */
export class HostEndpoint {
  readonly url: URL;

  constructor(input: string) {
    const trimmed = input.trim();
    if (trimmed === '') throw new HostError('empty host; pass --host http://127.0.0.1:<port>');
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      throw new HostError(
        `invalid host "${input}"; expected a URL such as http://127.0.0.1:49904`,
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new HostError(`unsupported host protocol "${url.protocol}" in "${input}"`);
    }
    if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
      throw new HostError(`host "${input}" must be an origin (no path, query, or fragment)`);
    }
    this.url = url;
  }

  /** `host:port` exactly as addressed; feeds the cookie name and DSH's fence. */
  get authority(): string {
    return this.url.host;
  }

  /** `http(s)://host:port` with no trailing slash. */
  get origin(): string {
    return this.url.origin;
  }

  /** `ws(s)://host:port` for the mux carrier. */
  get wsOrigin(): string {
    return this.url.origin.replace(/^http/, 'ws');
  }

  toString(): string {
    return this.origin;
  }
}

interface ClientRequestEnvelope {
  type: 'client-request';
  rpcId: string;
  method: string;
  payload: { args: unknown };
}

interface ServerResponseEnvelope {
  type?: unknown;
  rpcId?: unknown;
  result?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One authenticated unary call. Every call mints a fresh local `rpcId` and
 * validates the server envelope instead of assuming it.
 */
export class RpcTransport {
  constructor(
    readonly endpoint: HostEndpoint,
    readonly cookie: string,
    readonly timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
    /** Only failure hints differ between the two auth paths. */
    readonly authPath: AuthPath = 'credentials',
  ) {}

  async call<T>(method: string, args: unknown): Promise<T> {
    const rpcId = randomUUID();
    const envelope: ClientRequestEnvelope = {
      type: 'client-request',
      rpcId,
      method,
      payload: { args },
    };

    let response: Response;
    try {
      response = await fetch(`${this.endpoint.origin}/api/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: this.cookie,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new HostError(
          `POST ${this.endpoint.origin}/api/${method} timed out after ${String(this.timeoutMs)} ms`,
          { cause: error },
        );
      }
      throw new HostError(
        `cannot reach DSH host ${this.endpoint.origin} (POST /api/${method}): ${String(error)}`,
        { cause: error },
      );
    }

    const raw = await response.text();
    if (!response.ok) {
      const snippet = raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
      if (response.status === 401) {
        throw new CredentialsError(
          this.authPath === 'url-token'
            ? `DSH host ${this.endpoint.origin} rejected the URL-token cookie (HTTP 401). ` +
                'DSH issues the token per launch: copy the URL the running instance printed ' +
                'and retry.'
            : `DSH host ${this.endpoint.origin} rejected the minted cookie (HTTP 401). ` +
                'The browser-session secret has rotated since DSH started; restart DSH and retry.',
        );
      }
      if (response.status === 403) {
        throw new CredentialsError(
          this.authPath === 'url-token'
            ? `DSH host ${this.endpoint.origin} rejected authority "${this.endpoint.authority}" ` +
                `(HTTP 403). Use the exact URL the running DSH printed: the token and the ` +
                'cookie belong to its host:port.'
            : `DSH host ${this.endpoint.origin} rejected authority "${this.endpoint.authority}" ` +
                `(HTTP 403). The cookie was minted for a different host:port; use the exact ` +
                'loopback authority DSH is listening on.',
        );
      }
      if (response.status === 404) {
        throw new ProtocolError(
          `DSH host ${this.endpoint.origin} has no /api/${method} endpoint (HTTP 404). ` +
            'This DSH build may be incompatible with dsh-bridge.',
        );
      }
      throw new ProtocolError(
        `POST ${this.endpoint.origin}/api/${method} returned HTTP ${String(response.status)}: ${snippet}`,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ProtocolError(
        `POST ${this.endpoint.origin}/api/${method} returned non-JSON (HTTP ${String(response.status)}): ` +
          raw.slice(0, 400),
      );
    }
    return unwrapResponse<T>(body, method, rpcId, this.endpoint.origin);
  }
}

/** Validate a `server-response` envelope and return `result.value`. */
export function unwrapResponse<T>(
  body: unknown,
  method: string,
  rpcId: string,
  origin: string,
): T {
  if (!isRecord(body)) {
    throw new ProtocolError(
      `POST ${origin}/api/${method}: expected a JSON object envelope, got ${typeof body}`,
    );
  }
  const envelope = body as ServerResponseEnvelope;
  if (envelope.type !== 'server-response') {
    throw new ProtocolError(
      `POST ${origin}/api/${method}: expected envelope type "server-response", got ` +
        `${JSON.stringify(envelope.type)}`,
    );
  }
  if (envelope.rpcId !== rpcId) {
    throw new ProtocolError(
      `POST ${origin}/api/${method}: response rpcId ${JSON.stringify(envelope.rpcId)} does not ` +
        `match request rpcId ${rpcId}`,
    );
  }
  if (!isRecord(envelope.result)) {
    throw new ProtocolError(
      `POST ${origin}/api/${method}: response has no result object: ${JSON.stringify(body).slice(0, 400)}`,
    );
  }
  const result = envelope.result;
  if (result.ok !== true) {
    if (result.ok === false) {
      // Hosts in the wild put the error at result.error (0.1.x) or directly
      // on result (spec §3.2); accept both and never print "unknown".
      const nested = isRecord(result.error) ? result.error : undefined;
      const code =
        typeof result.code === 'string'
          ? result.code
          : typeof nested?.code === 'string'
            ? nested.code
            : 'unknown';
      const message =
        typeof result.message === 'string'
          ? result.message
          : typeof nested?.message === 'string'
            ? nested.message
            : '(no message)';
      throw new RpcError(method, code, message, result.details ?? nested?.details);
    }
    throw new ProtocolError(
      `POST ${origin}/api/${method}: result.ok must be true or false, got ` +
        `${JSON.stringify(result.ok)}`,
    );
  }
  return result.value as T;
}

/* ------------------------------------------------------------ host resolution */

export type HostSource =
  | 'flag'
  | 'url'
  | 'env'
  | 'url-env'
  | 'config-url'
  | 'config-host'
  | 'discovery';

export interface ResolvedHost {
  endpoint: HostEndpoint;
  cookie: string;
  /** DSH home actually used (`--dsh-home` → `$DSH_HOME` → config → `~/.dsh`). */
  dshHome: string;
  /** Where the host came from; `doctor` reports this. */
  source: HostSource;
  /** Config path consulted, whether or not the file existed. */
  configFile: string;
  /** `url-token` (exchanged from the launch URL) or `credentials` (minted). */
  authPath: AuthPath;
  /** Which input supplied the URL token or the credential file. */
  authSource: AuthSource;
  /** A usable credentials record exists, so the other path would also work. */
  credentialsAvailable: boolean;
}

export interface ResolveHostOptions {
  /** `--host`, already higher priority than `DSH_BRIDGE_HOST`. */
  host?: string;
  /** `--url`: the launch URL `dsh web` printed, `?token=` included. Wins over `host`. */
  url?: string;
  /** `--dsh-home`; when absent, `$DSH_HOME`, then the config file, then `~/.dsh`. */
  dshHome?: string;
  /** Front end asking; changes only the fix hint in discovery errors. */
  caller?: CallerKind;
  /** Optional diagnostic sink; discovery stays silent on success. */
  onDiscoveryNote?: (message: string) => void;
  /* Test seams. Production callers leave these unset. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  configPath?: string;
  platform?: NodeJS.Platform;
  probes?: readonly DiscoveryProbe[];
  confirm?: (endpoint: HostEndpoint, cookie: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  exchangeTimeoutMs?: number;
}

/** Human-readable platform name used in discovery failure messages. */
export function platformLabel(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return 'macOS (darwin)';
    case 'linux':
      return 'Linux (linux)';
    case 'win32':
      return 'Windows (win32)';
    default:
      return `platform "${platform}"`;
  }
}

function fixHint(caller: CallerKind): string {
  return caller === 'mcp'
    ? 'Set DSH_BRIDGE_HOST=http://127.0.0.1:<port> in the MCP server environment, or add ' +
        '"host" to the dsh-bridge config file.'
    : 'Pass --host http://127.0.0.1:<port>, or add "host" to the dsh-bridge config file.';
}

/** Appended when the credentials path is the only one available. */
const CREDENTIAL_FIX =
  'No URL token is configured. For a `dsh web` host, pass the URL it printed ' +
  '(--url or DSH_BRIDGE_URL); for the desktop app, start DSH once with its Web host so ' +
  '`$DSH_HOME/.credentials.yaml` gains the browser-session record.';

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** Cheap probe: does a usable browser-session record exist? Never returns the secret. */
function credentialsAvailable(dshHome: string): boolean {
  try {
    loadBrowserSessionSecret(dshHome);
    return true;
  } catch {
    return false;
  }
}

/** Load the signing secret, naming the alternative auth path when it is missing. */
function loadSecret(dshHome: string): Buffer {
  try {
    return loadBrowserSessionSecret(dshHome);
  } catch (error) {
    if (error instanceof CredentialsError) {
      throw new CredentialsError(`${error.message}\n${CREDENTIAL_FIX}`, { cause: error });
    }
    throw error;
  }
}

/** Parse the config file's `url`; never echo it (it may embed a launch token). */
function parseConfigUrl(loaded: LoadedConfig): URL | undefined {
  const raw = loaded.config?.url;
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new ConfigError(`config file ${loaded.path}: "url" is not a valid absolute URL`, {
      cause: error,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(
      `config file ${loaded.path}: "url" must use http or https, got "${url.protocol}"`,
    );
  }
  return url;
}

function exchangeOptions(
  options: ResolveHostOptions,
  source: string,
): { source: string; fetchImpl?: typeof fetch; timeoutMs?: number } {
  return {
    source,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.exchangeTimeoutMs === undefined ? {} : { timeoutMs: options.exchangeTimeoutMs }),
  };
}

async function defaultConfirm(endpoint: HostEndpoint, cookie: string): Promise<void> {
  const transport = new RpcTransport(endpoint, cookie);
  await transport.call<{ items?: unknown[] }>('session/list', { _request: {} });
}

/** Build a resolved host for the credential-minting path. */
function credentialsHost(args: {
  endpoint: HostEndpoint;
  secret: Buffer;
  dshHome: string;
  source: HostSource;
  configFile: string;
}): ResolvedHost {
  return {
    endpoint: args.endpoint,
    cookie: mintBrowserCookie({ secret: args.secret, authority: args.endpoint.authority }).header,
    dshHome: args.dshHome,
    source: args.source,
    configFile: args.configFile,
    authPath: 'credentials',
    authSource: 'credentials',
    credentialsAvailable: true,
  };
}

/**
 * Resolve the host and its cookie.
 *
 * Order: `--url` → `DSH_BRIDGE_URL` (URL token, always wins) → `--host` →
 * `DSH_BRIDGE_HOST` → config file (`url`, then `host`) → platform discovery.
 * The config file is read (and validated) on every call, including when an
 * explicit host wins, so a broken config is never silently ignored.
 *
 * A failed URL-token exchange is never retried through credential minting —
 * not for `--url`, not for `DSH_BRIDGE_URL`, and not for the config file's
 * `url`: a token that stopped working is a fact the caller must see.
 */
export async function resolveHost(options: ResolveHostOptions = {}): Promise<ResolvedHost> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const caller = options.caller ?? 'cli';

  const loaded = loadConfig({
    env,
    homeDir,
    ...(options.configPath === undefined ? {} : { path: options.configPath }),
  });
  const dshHome = resolveDshHome({
    ...(options.dshHome === undefined ? {} : { flag: options.dshHome }),
    env,
    homeDir,
    ...(loaded.config === undefined ? {} : { config: loaded.config }),
  });

  const flagHost = nonEmpty(options.host);
  const envHost = nonEmpty(env.DSH_BRIDGE_HOST);
  const explicitHost = flagHost ?? envHost;
  const explicitHostLabel = flagHost !== undefined ? '--host' : 'DSH_BRIDGE_HOST';

  const flagUrl = nonEmpty(options.url);
  const envUrl = nonEmpty(env.DSH_BRIDGE_URL);
  const explicitUrl = flagUrl ?? envUrl;
  if (explicitUrl !== undefined) {
    const urlSource = flagUrl !== undefined ? '--url' : 'DSH_BRIDGE_URL';
    const launch = parseLaunchUrl(explicitUrl, urlSource);
    if (explicitHost !== undefined) {
      const declared = new HostEndpoint(explicitHost);
      if (declared.origin !== launch.origin) {
        throw new HostError(
          `${urlSource} addresses ${launch.origin} but ${explicitHostLabel} addresses ` +
            `${declared.origin}; they must name the same origin. The URL token is exchanged ` +
            'with the origin in the URL, so use one input or make them agree.',
        );
      }
    }
    const exchanged = await exchangeUrlToken(launch, exchangeOptions(options, urlSource));
    return {
      endpoint: new HostEndpoint(exchanged.origin),
      cookie: exchanged.cookie,
      dshHome,
      source: flagUrl !== undefined ? 'url' : 'url-env',
      configFile: loaded.path,
      authPath: 'url-token',
      authSource: flagUrl !== undefined ? 'flag' : 'env',
      credentialsAvailable: credentialsAvailable(dshHome),
    };
  }

  if (explicitHost !== undefined) {
    const endpoint = new HostEndpoint(explicitHost);
    return credentialsHost({
      endpoint,
      secret: loadSecret(dshHome),
      dshHome,
      source: flagHost !== undefined ? 'flag' : 'env',
      configFile: loaded.path,
    });
  }

  const configuredUrl = parseConfigUrl(loaded);
  if (configuredUrl !== undefined) {
    const rawUrl = loaded.config?.url ?? '';
    if (hasUrlToken(rawUrl)) {
      const launch = (() => {
        try {
          return parseLaunchUrl(rawUrl, '"url"');
        } catch (error) {
          throw new ConfigError(
            `config file ${loaded.path}: ${(error as Error).message}`,
            { cause: error },
          );
        }
      })();
      const exchanged = await exchangeUrlToken(
        launch,
        exchangeOptions(options, `the "url" in ${loaded.path}`),
      );
      return {
        endpoint: new HostEndpoint(exchanged.origin),
        cookie: exchanged.cookie,
        dshHome,
        source: 'config-url',
        configFile: loaded.path,
        authPath: 'url-token',
        authSource: 'config',
        credentialsAvailable: credentialsAvailable(dshHome),
      };
    }
    return credentialsHost({
      endpoint: new HostEndpoint(configuredUrl.origin),
      secret: loadSecret(dshHome),
      dshHome,
      source: 'config-url',
      configFile: loaded.path,
    });
  }

  if (loaded.config?.host !== undefined) {
    let endpoint: HostEndpoint;
    try {
      endpoint = new HostEndpoint(loaded.config.host);
    } catch (error) {
      throw new ConfigError(
        `config file ${loaded.path}: invalid "host": ${(error as Error).message}`,
        { cause: error },
      );
    }
    return credentialsHost({
      endpoint,
      secret: loadSecret(dshHome),
      dshHome,
      source: 'config-host',
      configFile: loaded.path,
    });
  }

  const secret = loadSecret(dshHome);
  const platform = options.platform ?? process.platform;
  const candidates = discoverLoopbackCandidates({
    platform,
    caller,
    ...(options.probes === undefined ? {} : { probes: options.probes }),
  });

  const confirm = options.confirm ?? defaultConfirm;
  const failures: string[] = [];
  for (const endpoint of candidates) {
    const cookie = mintBrowserCookie({ secret, authority: endpoint.authority }).header;
    try {
      await confirm(endpoint, cookie);
      return {
        endpoint,
        cookie,
        dshHome,
        source: 'discovery',
        configFile: loaded.path,
        authPath: 'credentials',
        authSource: 'credentials',
        credentialsAvailable: true,
      };
    } catch (error) {
      failures.push(`${endpoint.origin}: ${(error as Error).message.split('\n')[0] ?? ''}`);
      options.onDiscoveryNote?.(
        `host discovery: ${endpoint.origin} did not confirm (${(error as Error).name})`,
      );
    }
  }

  throw new HostError(
    `automatic host discovery on ${platformLabel(platform)} found ` +
      `${String(candidates.length)} candidate(s), but none accepted an authenticated ` +
      `session/list:\n  ${failures.join('\n  ')}\n${fixHint(caller)}`,
  );
}

/* --------------------------------------------------------------- discovery */

interface ListeningSocket {
  pid: number;
  command: string;
}

export interface DiscoveryCommand {
  file: string;
  args: string[];
}

/** Runs one probe command and returns stdout; throws when it cannot run. */
export type CommandRunner = (command: DiscoveryCommand) => string;

export const defaultCommandRunner: CommandRunner = (command) =>
  execFileSync(command.file, command.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });

/** A platform-specific way to enumerate loopback listeners. */
export interface DiscoveryProbe {
  /** Short name shown in failure messages, e.g. `lsof` or `Get-NetTCPConnection`. */
  readonly name: string;
  /** The command this probe runs, shown in failure messages. */
  readonly detail: string;
  /** Candidates, best first. Throws when the underlying command cannot run. */
  run(): HostEndpoint[];
}

export interface ProbeOptions {
  runner?: CommandRunner;
}

/**
 * macOS (and the Linux fallback): enumerate listening loopback TCP sockets
 * owned by this user, keep processes whose command line mentions DeepSeek
 * Harness or dsh.
 */
export function lsofProbe(options: ProbeOptions = {}): DiscoveryProbe {
  const runner = options.runner ?? defaultCommandRunner;
  const uid = userInfo().uid;
  const command: DiscoveryCommand = {
    file: 'lsof',
    args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-u', String(uid), '-a'],
  };
  return {
    name: 'lsof',
    detail: `${command.file} ${command.args.join(' ')}`,
    run(): HostEndpoint[] {
      // lsof exits 1 when it cannot stat some matched process, but still prints
      // the sockets it did resolve; keep that partial output.
      let output: string;
      try {
        output = runner(command);
      } catch (error) {
        const stdout = (error as { stdout?: unknown }).stdout;
        if (typeof stdout === 'string' && stdout.trim() !== '') {
          output = stdout;
        } else {
          throw error;
        }
      }
      const sockets = parseLsofListeners(output);
      return endpointsFromSockets(sockets, readProcessCommands(uniquePids(sockets), runner));
    },
  };
}

/** Linux, first choice: `ss -ltnp`, with process command lines via `ps`. */
export function ssProbe(options: ProbeOptions = {}): DiscoveryProbe {
  const runner = options.runner ?? defaultCommandRunner;
  const command: DiscoveryCommand = { file: 'ss', args: ['-ltnp'] };
  return {
    name: 'ss',
    detail: 'ss -ltnp',
    run(): HostEndpoint[] {
      const sockets = parseSsListeners(runner(command));
      return endpointsFromSockets(sockets, readProcessCommands(uniquePids(sockets), runner));
    },
  };
}

/*
 * Windows: one PowerShell invocation, `-NoProfile` so no user profile can make
 * it interactive or slow. Get-NetTCPConnection gives the listener and owning
 * pid; Get-CimInstance supplies the command line used to recognize DSH.
 */
const WINDOWS_DISCOVERY_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' } |
  ForEach-Object {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)"
    [pscustomobject]@{
      Address = $_.LocalAddress
      Port = [int]$_.LocalPort
      Pid = [int]$_.OwningProcess
      Command = [string]$process.CommandLine
    }
  } | ConvertTo-Json -Compress
`;

/**
 * Windows discovery (best effort; sending on Windows is untested per the
 * release contract). Confirmation by `session/list` is the real gate.
 */
export function windowsProbe(options: ProbeOptions = {}): DiscoveryProbe {
  const runner = options.runner ?? defaultCommandRunner;
  const command: DiscoveryCommand = {
    file: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_DISCOVERY_SCRIPT],
  };
  return {
    name: 'Get-NetTCPConnection',
    detail: 'powershell -NoProfile -Command Get-NetTCPConnection -State Listen',
    run(): HostEndpoint[] {
      return endpointsFromSockets(parseWindowsListeners(runner(command)), new Map());
    },
  };
}

/** The probes for a platform, in the order they should be tried. */
export function platformProbes(
  platform: NodeJS.Platform,
  options: ProbeOptions = {},
): DiscoveryProbe[] {
  const probeOptions: ProbeOptions = options.runner === undefined ? {} : { runner: options.runner };
  switch (platform) {
    case 'darwin':
      return [lsofProbe(probeOptions)];
    case 'linux':
      return [ssProbe(probeOptions), lsofProbe(probeOptions)];
    case 'win32':
      return [windowsProbe(probeOptions)];
    default:
      return [];
  }
}

export interface DiscoverLoopbackOptions {
  platform?: NodeJS.Platform;
  /** Override the platform probes (unit tests inject fakes). */
  probes?: readonly DiscoveryProbe[];
  caller?: CallerKind;
}

/**
 * Run the platform probes in order and return the first non-empty candidate
 * list. Candidates are not yet trusted: `resolveHost` confirms each with an
 * authenticated `session/list`.
 *
 * When every probe fails or finds nothing, the error names the platform, every
 * probe tried, and the fix for this caller (CLI flag vs MCP environment).
 */
export function discoverLoopbackCandidates(
  options: DiscoverLoopbackOptions = {},
): HostEndpoint[] {
  const platform = options.platform ?? process.platform;
  const caller = options.caller ?? 'cli';
  const probes = options.probes ?? platformProbes(platform);

  if (probes.length === 0) {
    throw new HostError(
      `automatic host discovery is not implemented on ${platformLabel(platform)}: no probe is ` +
        `registered for it.\n${fixHint(caller)}`,
    );
  }

  const attempts: string[] = [];
  for (const probe of probes) {
    try {
      const endpoints = probe.run();
      if (endpoints.length > 0) return endpoints;
      attempts.push(`  ${probe.name} (${probe.detail}): ran, found no matching loopback listener`);
    } catch (error) {
      attempts.push(
        `  ${probe.name} (${probe.detail}): cannot run: ` +
          `${(error as Error).message.split('\n')[0] ?? ''}`,
      );
    }
  }

  throw new HostError(
    `automatic host discovery could not find a DSH Web host on ${platformLabel(platform)}.\n` +
      `Tried:\n${attempts.join('\n')}\n${fixHint(caller)}`,
  );
}

function uniquePids(sockets: Map<number, ListeningSocket>): number[] {
  return [...new Set([...sockets.values()].map((socket) => socket.pid))];
}

function endpointsFromSockets(
  sockets: Map<number, ListeningSocket>,
  commands: Map<number, string>,
): HostEndpoint[] {
  const candidates: { endpoint: HostEndpoint; score: number }[] = [];
  for (const [port, socket] of sockets) {
    const command = commands.get(socket.pid) ?? socket.command;
    if (!/\bDeepSeek Harness\b|\bdsh\b/i.test(command)) continue;
    const score = /\bDeepSeek Harness\b/i.test(command) ? 0 : 1;
    try {
      candidates.push({ endpoint: new HostEndpoint(`http://127.0.0.1:${String(port)}`), score });
    } catch {
      // A non-TCP-shaped NAME slipped through the parser; skip it.
    }
  }
  candidates.sort(
    (left, right) => left.score - right.score || compareEndpoint(left.endpoint, right.endpoint),
  );
  return candidates.map((candidate) => candidate.endpoint);
}

/** Parse the NAME/PID columns of `lsof -nP -iTCP -sTCP:LISTEN`. */
export function parseLsofListeners(output: string): Map<number, ListeningSocket> {
  const sockets = new Map<number, ListeningSocket>();
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9 || fields[0] === 'COMMAND') continue;
    const pid = Number(fields[1]);
    const tcpName = /TCP\s+(\S+?)(?:\s+\(LISTEN\))?\s*$/.exec(line);
    const name = tcpName?.[1] ?? '';
    const match = /^(?:127\.0\.0\.1|\[::1\]):(\d+)$/.exec(name);
    if (!Number.isSafeInteger(pid) || match === null) continue;
    const port = Number(match[1]);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) continue;
    if (!sockets.has(port)) {
      sockets.set(port, { pid, command: fields[0] ?? '' });
    }
  }
  return sockets;
}

/**
 * Parse `ss -ltnp`. Loopback only; a listener without a visible pid (another
 * user's process) is skipped because it cannot be attributed or confirmed.
 */
export function parseSsListeners(output: string): Map<number, ListeningSocket> {
  const sockets = new Map<number, ListeningSocket>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('State')) continue;
    const local = /(?:127\.0\.0\.1|\[::1\]):(\d+)/.exec(trimmed);
    if (local === null) continue;
    const pidMatch = /pid=(\d+)/.exec(trimmed);
    if (pidMatch === null) continue;
    const port = Number(local[1]);
    const pid = Number(pidMatch[1]);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) continue;
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const command = /users:\(\("([^"]+)"/.exec(trimmed)?.[1] ?? '';
    if (!sockets.has(port)) sockets.set(port, { pid, command });
  }
  return sockets;
}

/**
 * Parse the JSON emitted by the Windows probe. `ConvertTo-Json` unwraps a
 * single-element pipeline into an object, so accept both shapes.
 */
export function parseWindowsListeners(output: string): Map<number, ListeningSocket> {
  const sockets = new Map<number, ListeningSocket>();
  const trimmed = output.trim();
  if (trimmed === '' || trimmed === 'null') return sockets;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return sockets;
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const address = item.Address;
    if (address !== '127.0.0.1' && address !== '::1') continue;
    const port = Number(item.Port);
    const pid = Number(item.Pid);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) continue;
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const command = typeof item.Command === 'string' ? item.Command : '';
    if (!sockets.has(port)) sockets.set(port, { pid, command });
  }
  return sockets;
}

function readProcessCommands(pids: number[], runner: CommandRunner): Map<number, string> {
  const commands = new Map<number, string>();
  if (pids.length === 0) return commands;
  try {
    const output = runner({ file: 'ps', args: ['-p', pids.join(','), '-o', 'pid=,command='] });
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match !== null) commands.set(Number(match[1]), match[2] ?? '');
    }
  } catch {
    // ps is best-effort; the probe's own COMMAND column remains as a fallback.
  }
  return commands;
}

function compareEndpoint(left: HostEndpoint, right: HostEndpoint): number {
  return left.url.port.localeCompare(right.url.port, undefined, { numeric: true });
}
