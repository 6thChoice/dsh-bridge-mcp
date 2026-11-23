#!/usr/bin/env node
/**
 * `dsh-bridge` CLI (spec §2, §8): sessions | send | result.
 *
 * stdout is a contract: plain `send`/`result` prints only the assistant text;
 * `--json` prints exactly one JSON object. Every diagnostic goes to stderr.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BridgeError } from './errors.js';
import { SessionClient, sessionCwd, sessionTitle, sessionUpdatedAt } from './client.js';
import { filterSessions, hasSelector, type Target } from './resolve.js';
import { sendMessage } from './run.js';
import { isNodeVersionSupported, nodeVersionMessage } from './runtime.js';
import { SendIndex, resultMessage } from './result.js';
import type { SessionRow } from './client.js';

const DEFAULT_TIMEOUT_SECONDS = 180;

const USAGE = `dsh-bridge — send one message to an existing DeepSeek Harness session

Usage:
  dsh-bridge sessions [target flags] [--limit <n>] [--json]
  dsh-bridge send <text> (target flags) [--from <name>] [--no-prefix]
                         [--steer] [--detach] [--timeout <seconds>] [--force] [--json]
  dsh-bridge result --rpc-id <id> [--wait] [--timeout <seconds>] [--json]

Target flags (exactly one family for send):
  --session <id|prefix>   exact session id or unique prefix (session- prefix ignored)
  --title <substr>        case-insensitive substring of the session title
  --cwd <path>            exact working directory (realpath-normalized)
  --latest                newest updatedAt among the filtered rows

Global:
  --host <url>            DSH Web origin (default: $DSH_BRIDGE_HOST, config file, then discovery)
  --dsh-home <dir>        DSH home for credentials + send index
                          (default: $DSH_HOME, config file dshHome, or ~/.dsh)
  --json                  print one JSON object instead of plain text
  -h, --help              this help

Config file (optional): \${XDG_CONFIG_HOME:-~/.config}/dsh-bridge/config.json
  keys: url, host, dshHome; unknown keys or bad JSON are errors.

Exit codes: 0 completed/pending, 2 timeout, 3 turn error/cancelled, 1 local error.
`;

class CliError extends Error {}

interface CliOptions {
  host?: string;
  /** Only set when `--dsh-home` was passed; resolution is config-aware. */
  dshHome?: string;
  json: boolean;
  target: Target;
  timeoutMs: number;
  from: string;
  prefix: boolean;
  detach: boolean;
  steer: boolean;
  force: boolean;
  wait: boolean;
  rpcId?: string;
  limit?: number;
  positionals: string[];
}

function usageError(message: string): never {
  throw new CliError(message);
}

function parsePositiveInteger(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) throw new CliError(`${flag} must be a positive integer, got "${raw}"`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CliError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function parseTimeout(raw: string | undefined): number {
  const source = raw ?? process.env.DSH_BRIDGE_TIMEOUT;
  if (source === undefined || source === '') return DEFAULT_TIMEOUT_SECONDS * 1000;
  if (!/^\d+(?:\.\d+)?$/.test(source)) {
    throw new CliError(`--timeout must be a positive number of seconds, got "${source}"`);
  }
  const seconds = Number(source);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError(`--timeout must be a positive number of seconds, got "${source}"`);
  }
  return Math.round(seconds * 1000);
}

function parseCli(argv: string[]): CliOptions {
  let values;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        host: { type: 'string' },
        'dsh-home': { type: 'string' },
        session: { type: 'string' },
        title: { type: 'string' },
        cwd: { type: 'string' },
        latest: { type: 'boolean' },
        limit: { type: 'string' },
        json: { type: 'boolean' },
        timeout: { type: 'string' },
        steer: { type: 'boolean' },
        detach: { type: 'boolean' },
        from: { type: 'string' },
        'no-prefix': { type: 'boolean' },
        force: { type: 'boolean' },
        'rpc-id': { type: 'string' },
        wait: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    throw new CliError((error as Error).message);
  }

  const target: Target = {};
  if (values.session !== undefined) target.session = values.session;
  if (values.title !== undefined) target.title = values.title;
  if (values.cwd !== undefined) target.cwd = values.cwd;
  if (values.latest === true) target.latest = true;

  const from = values.from ?? process.env.DSH_BRIDGE_FROM ?? 'cli';
  if (from.trim() === '') throw new CliError('--from must not be empty');
  if (/[\r\n]/.test(from)) throw new CliError('--from must not contain newlines');

  const options: CliOptions = {
    json: values.json === true,
    target,
    timeoutMs: parseTimeout(values.timeout),
    from,
    prefix: values['no-prefix'] !== true,
    detach: values.detach === true,
    steer: values.steer === true,
    force: values.force === true,
    wait: values.wait === true,
    positionals,
  };
  if (values.host !== undefined) options.host = values.host;
  if (values['dsh-home'] !== undefined) options.dshHome = values['dsh-home'];
  if (values.limit !== undefined) options.limit = parsePositiveInteger(values.limit, '--limit');
  if (values['rpc-id'] !== undefined) options.rpcId = values['rpc-id'];
  return options;
}

function printRows(rows: SessionRow[]): void {
  for (const row of rows) {
    const updatedAt =
      typeof row.updatedAt === 'number' ? new Date(row.updatedAt).toISOString() : '';
    const line = [
      row.sessionId,
      String(row.running === true),
      updatedAt,
      sessionTitle(row),
      sessionCwd(row) ?? '',
    ].join('\t');
    process.stdout.write(`${line}\n`);
  }
}

function sortRows(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left));
}

async function openClient(options: CliOptions): Promise<SessionClient> {
  return SessionClient.connect({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.dshHome === undefined ? {} : { dshHome: options.dshHome }),
    caller: 'cli',
  });
}

async function commandSessions(options: CliOptions): Promise<number> {
  if (options.positionals.length > 1) {
    throw new CliError(`sessions takes no arguments, got "${options.positionals.slice(1).join(' ')}"`);
  }
  const client = await openClient(options);
  const rows = await client.listSessions();
  let filtered = sortRows(filterSessions(rows, options.target));
  if (options.limit !== undefined) filtered = filtered.slice(0, options.limit);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(filtered)}\n`);
  } else {
    printRows(filtered);
  }
  return 0;
}

function printResult(
  result: { rpcId: string; status: string; text: string },
  options: { json: boolean; detach: boolean },
  timeoutHint: string | undefined,
): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (options.detach) {
    process.stdout.write(`${result.rpcId}\n`);
  } else if (result.text !== '') {
    process.stdout.write(`${result.text}\n`);
  }
  if (timeoutHint !== undefined) process.stderr.write(`${timeoutHint}\n`);
}

async function commandSend(options: CliOptions): Promise<number> {
  const text = options.positionals.slice(1).join(' ');
  if (text === '') {
    throw new CliError('send needs a message: dsh-bridge send <text> --session <id>');
  }
  if (!hasSelector(options.target)) {
    throw new CliError(
      'send needs a target: pass --session <id|prefix>, --title <substr>, --cwd <path>, or --latest',
    );
  }
  const client = await openClient(options);
  const outcome = await sendMessage({
    client,
    target: options.target,
    text,
    from: options.from,
    prefix: options.prefix,
    mode: options.steer ? 'steer' : 'queue',
    timeoutMs: options.timeoutMs,
    detach: options.detach,
    force: options.force,
    index: new SendIndex(client.dshHome),
  });
  printResult(outcome.result, { json: options.json, detach: options.detach }, outcome.timeoutHint);
  if (
    !options.json &&
    !options.detach &&
    (outcome.result.status === 'error' || outcome.result.status === 'cancelled')
  ) {
    process.stderr.write(
      `dsh-bridge: turn ${String(outcome.result.turn ?? '?')} ended with ` +
        `status=${outcome.result.status} (reason kind ` +
        `${JSON.stringify(outcome.result.reason.kind ?? 'unknown')})\n`,
    );
  }
  return outcome.exitCode;
}

async function commandResult(options: CliOptions): Promise<number> {
  if (options.rpcId === undefined || options.rpcId === '') {
    throw new CliError('result needs --rpc-id <id>');
  }
  if (options.positionals.length > 1) {
    throw new CliError(`result takes no arguments, got "${options.positionals.slice(1).join(' ')}"`);
  }
  const client = await openClient(options);
  const outcome = await resultMessage({
    client,
    index: new SendIndex(client.dshHome),
    rpcId: options.rpcId,
    wait: options.wait,
    timeoutMs: options.timeoutMs,
  });
  printResult(outcome.result, { json: options.json, detach: false }, outcome.timeoutHint);
  return outcome.exitCode;
}

/** Run the CLI and return its intended exit code; never calls process.exit. */
export async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    process.stderr.write(`dsh-bridge: ${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }

  if (argv.includes('--help') || argv.includes('-h') || options.positionals.length === 0) {
    if (options.positionals.length === 0 && !argv.includes('--help') && !argv.includes('-h')) {
      process.stderr.write(USAGE);
      return 1;
    }
    process.stdout.write(USAGE);
    return 0;
  }

  const command = options.positionals[0];
  try {
    switch (command) {
      case 'sessions':
        return await commandSessions(options);
      case 'send':
        return await commandSend(options);
      case 'result':
        return await commandResult(options);
      default:
        throw new CliError(`unknown command "${command ?? ''}"; expected sessions, send, or result`);
    }
  } catch (error) {
    if (error instanceof BridgeError || error instanceof CliError) {
      process.stderr.write(`dsh-bridge: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(`dsh-bridge: unexpected failure: ${String(error)}\n`);
    if (error instanceof Error && error.stack !== undefined) {
      process.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    // npm link runs the bin through a symlink; compare real paths.
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (invokedDirectly()) {
  if (!isNodeVersionSupported()) {
    process.stderr.write(`${nodeVersionMessage()}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = await main(process.argv.slice(2));
  }
}
