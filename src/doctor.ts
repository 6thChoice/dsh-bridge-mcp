/**
 * `dsh-bridge doctor [--json]` (release contract: "New commands").
 *
 * One screen that answers: which host, how was it resolved, which auth path
 * produced the cookie, does that cookie pass a real authenticated
 * `session/list`, how many sessions are visible, and how fast. Every failing
 * check carries the concrete next step. Exit 0 only when the bridge could
 * actually send: the probe must be accepted *and* at least one session must be
 * visible (a send with no target cannot succeed).
 *
 * Nothing secret is printed: the report holds a host origin, an auth-path
 * label, timings, counts, and error text from modules that never echo a token,
 * secret, or cookie value.
 */

import { SessionClient } from './client.js';
import { type HostEndpoint, type HostSource, type ResolveHostOptions, resolveHost } from './host.js';
import { CredentialsError, HostError } from './errors.js';

/** Reachability and probe budget: a diagnostic should not hang. */
export const DEFAULT_DOCTOR_TIMEOUT_MS = 10_000;

export type CheckName = 'host' | 'auth' | 'reachability' | 'session/list' | 'sessions';

/** Outcome of the authenticated probe. */
export type ProbeStatus = 'accepted' | 'denied' | 'unreachable' | 'error';

export interface DoctorCheck {
  name: CheckName;
  ok: boolean;
  detail: string;
  /** Concrete fix when `ok` is false; null when nothing actionable remains. */
  nextStep: string | null;
}

export interface DoctorReport {
  /** True only when a `send` could succeed right now. */
  ok: boolean;
  /** Resolved origin, or null when resolution failed. */
  host: string | null;
  /** `flag`, `url`, `env`, `url-env`, `config-url`, `config-host`, `discovery`, or null. */
  hostSource: HostSource | null;
  /** `url-token`, `credentials`, or null when resolution failed. */
  authPath: 'url-token' | 'credentials' | null;
  /** `flag`, `env`, `config`, `credentials`, or null. */
  authSource: 'flag' | 'env' | 'config' | 'credentials' | null;
  /** A usable credentials record also exists (the URL path still won). */
  credentialsAvailable: boolean;
  reachability: { ok: boolean; latencyMs: number | null; detail: string };
  probe: {
    endpoint: 'session/list';
    status: ProbeStatus;
    latencyMs: number | null;
    detail: string;
  };
  /** Rows visible to `session/list`; 0 when the probe failed. */
  sessionCount: number;
  checks: DoctorCheck[];
}

export interface DoctorOptions extends ResolveHostOptions {
  /** Probe budget; defaults to {@link DEFAULT_DOCTOR_TIMEOUT_MS}. */
  timeoutMs?: number;
}

function now(): number {
  return performance.now();
}

function hostSourceLabel(source: HostSource): string {
  switch (source) {
    case 'flag':
      return '--host';
    case 'url':
      return '--url';
    case 'env':
      return 'DSH_BRIDGE_HOST';
    case 'url-env':
      return 'DSH_BRIDGE_URL';
    case 'config-url':
      return 'the config file "url"';
    case 'config-host':
      return 'the config file "host"';
    case 'discovery':
      return 'automatic loopback discovery';
    default:
      return String(source);
  }
}

function authSourceLabel(report: Pick<DoctorReport, 'authPath' | 'authSource'>): string {
  if (report.authPath === 'url-token') {
    switch (report.authSource) {
      case 'flag':
        return '--url';
      case 'env':
        return 'DSH_BRIDGE_URL';
      case 'config':
        return 'the config file "url"';
      default:
        return 'the URL token';
    }
  }
  return '$DSH_HOME/.credentials.yaml';
}

async function measureReachability(
  endpoint: HostEndpoint,
  options: DoctorOptions,
): Promise<DoctorReport['reachability']> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS;
  const started = now();
  try {
    const response = await doFetch(`${endpoint.origin}/`, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.round(now() - started);
    discardBody(response);
    return {
      ok: true,
      latencyMs,
      detail:
        `HTTP ${String(response.status)} from ${endpoint.origin} in ${String(latencyMs)} ms ` +
        '(reachable)',
    };
  } catch (error) {
    const latencyMs = Math.round(now() - started);
    return {
      ok: false,
      latencyMs,
      detail:
        `cannot reach ${endpoint.origin} (GET / failed after ${String(latencyMs)} ms): ` +
        `${(error as Error).message}`,
    };
  }
}

function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Already consumed; nothing to release.
  }
}

function classifyProbeError(error: unknown): ProbeStatus {
  if (error instanceof CredentialsError) return 'denied';
  if (error instanceof HostError) return 'unreachable';
  return 'error';
}

const FIX_HOST_FAILURE =
  'Fix that failure, then re-run `dsh-bridge doctor`. For a `dsh web` host, pass the URL it ' +
  'printed with --url (or set DSH_BRIDGE_URL); for the desktop app, start DSH once with its Web ' +
  'host so the credentials record exists; to pin a host, use --host http://127.0.0.1:<port>.';

function probeNextStep(status: ProbeStatus): string {
  switch (status) {
    case 'denied':
      return (
        'The host answered but rejected the cookie. For the URL-token path, copy the URL the ' +
        'running DSH printed (tokens are issued per launch). For the credentials path, restart ' +
        'DSH so a fresh browser-session secret is minted, then retry.'
      );
    case 'unreachable':
      return (
        'Nothing answered at the resolved origin. Confirm DSH Web is running and that the host ' +
        'is the exact origin it printed (the port changes across restarts).'
      );
    default:
      return (
        'The host answered but the probe failed. Check that this is a DSH Web host and that its ' +
        'version is compatible with dsh-bridge; re-run with --host pointing at the right origin.'
      );
  }
}

/**
 * Run every check. Never throws for an expected failure: the report carries it,
 * because `--json` consumers need the same data as humans.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS;
  const checks: DoctorCheck[] = [];

  const report: DoctorReport = {
    ok: false,
    host: null,
    hostSource: null,
    authPath: null,
    authSource: null,
    credentialsAvailable: false,
    reachability: { ok: false, latencyMs: null, detail: 'not checked' },
    probe: { endpoint: 'session/list', status: 'error', latencyMs: null, detail: 'not run' },
    sessionCount: 0,
    checks,
  };

  let client: SessionClient | undefined;
  try {
    const resolved = await resolveHost(options);
    client = new SessionClient(resolved.endpoint, resolved.cookie, {
      dshHome: resolved.dshHome,
      hostSource: resolved.source,
      authPath: resolved.authPath,
      credentialsAvailable: resolved.credentialsAvailable,
      rpcTimeoutMs: timeoutMs,
    });
    report.host = resolved.endpoint.origin;
    report.hostSource = resolved.source;
    report.authPath = resolved.authPath;
    report.authSource = resolved.authSource;
    report.credentialsAvailable = resolved.credentialsAvailable;
    checks.push({
      name: 'host',
      ok: true,
      detail: `${resolved.endpoint.origin} — via ${hostSourceLabel(resolved.source)}`,
      nextStep: null,
    });
    const both = resolved.authPath === 'url-token' && resolved.credentialsAvailable;
    checks.push({
      name: 'auth',
      ok: true,
      detail:
        `${authSourceLabel(report)} produced the cookie` +
        (both ? '; a credential record also exists, and the URL token wins' : ''),
      nextStep: null,
    });
  } catch (error) {
    const firstLine = (error as Error).message.split('\n')[0] ?? String(error);
    checks.push({
      name: 'host',
      ok: false,
      detail: `unresolved: ${firstLine}`,
      nextStep: FIX_HOST_FAILURE,
    });
    checks.push({
      name: 'auth',
      ok: false,
      detail: 'not reached: no host/auth path produced a cookie',
      nextStep: 'Fix the host/auth failure above, then re-run `dsh-bridge doctor`.',
    });
    checks.push({
      name: 'reachability',
      ok: false,
      detail: 'not checked: no resolved host',
      nextStep: 'Fix the host failure above, then re-run `dsh-bridge doctor`.',
    });
    checks.push({
      name: 'session/list',
      ok: false,
      detail: 'not run: no resolved host',
      nextStep: 'Fix the host failure above, then re-run `dsh-bridge doctor`.',
    });
    checks.push({
      name: 'sessions',
      ok: false,
      detail: 'not counted: no resolved host',
      nextStep: 'Fix the host failure above, then re-run `dsh-bridge doctor`.',
    });
    return report;
  }

  const endpoint = client.endpoint;
  report.reachability = await measureReachability(endpoint, options);
  checks.push({
    name: 'reachability',
    ok: report.reachability.ok,
    detail: report.reachability.detail,
    nextStep: report.reachability.ok
      ? null
      : 'Start DSH Web (or `dsh web --no-open`) and pass the exact origin it printed; ' +
        'the port changes across restarts.',
  });

  const probeStarted = now();
  try {
    const rows = await client.listSessions();
    const latencyMs = Math.round(now() - probeStarted);
    report.probe = {
      endpoint: 'session/list',
      status: 'accepted',
      latencyMs,
      detail: `accepted in ${String(latencyMs)} ms`,
    };
    report.sessionCount = rows.length;
    checks.push({
      name: 'session/list',
      ok: true,
      detail: `accepted in ${String(latencyMs)} ms (authenticated as ${report.authPath ?? 'unknown'})`,
      nextStep: null,
    });
  } catch (error) {
    const latencyMs = Math.round(now() - probeStarted);
    const status = classifyProbeError(error);
    report.probe = {
      endpoint: 'session/list',
      status,
      latencyMs,
      detail: `${status}: ${(error as Error).message}`,
    };
    checks.push({
      name: 'session/list',
      ok: false,
      detail: `${status}: ${(error as Error).message.split('\n')[0] ?? ''}`,
      nextStep: probeNextStep(status),
    });
  }

  if (report.probe.status === 'accepted') {
    checks.push({
      name: 'sessions',
      ok: report.sessionCount > 0,
      detail:
        report.sessionCount > 0
          ? `${String(report.sessionCount)} session(s) visible`
          : '0 sessions visible',
      nextStep:
        report.sessionCount > 0
          ? null
          : 'Open or create a session in DSH, then re-run `dsh-bridge doctor`.',
    });
  } else {
    checks.push({
      name: 'sessions',
      ok: false,
      detail: 'not counted: the session/list probe failed',
      nextStep: 'Fix the session/list failure above, then re-run `dsh-bridge doctor`.',
    });
  }

  report.ok = report.probe.status === 'accepted' && report.sessionCount > 0;
  return report;
}

/** One-screen text form. Nothing secret can appear: the report holds no cookie. */
export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = ['dsh-bridge doctor', ''];
  const row = (label: string, value: string): void => {
    lines.push(`  ${label.padEnd(13)} ${value}`);
  };

  const via =
    report.hostSource === null ? '' : `  (via ${hostSourceLabel(report.hostSource)})`;
  row('host', report.host === null ? 'unresolved' : `${report.host}${via}`);

  if (report.authPath === null) {
    row('auth', 'unresolved');
  } else {
    const both = report.authPath === 'url-token' && report.credentialsAvailable;
    row(
      'auth',
      `${report.authPath}  (${authSourceLabel(report)})` +
        (both ? '; a credential record also exists — the URL token wins' : ''),
    );
  }

  row('reachability', report.reachability.detail);
  row(
    'session/list',
    report.probe.latencyMs === null
      ? report.probe.detail
      : `${report.probe.status} in ${String(report.probe.latencyMs)} ms`,
  );
  row('sessions', `${String(report.sessionCount)} visible`);

  const failing = report.checks.filter((check) => !check.ok);
  lines.push('');
  if (failing.length === 0) {
    lines.push('  ok — the bridge can send through this host.');
  } else {
    for (const check of failing) {
      lines.push(`  FAIL  ${check.name}: ${check.detail}`);
      if (check.nextStep !== null) {
        for (const [index, line] of check.nextStep.split('\n').entries()) {
          lines.push(index === 0 ? `        next: ${line}` : `              ${line}`);
        }
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
