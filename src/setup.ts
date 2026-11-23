/**
 * `dsh-bridge setup <harness> [--write] [--from <name>]` (release contract:
 * "New commands").
 *
 * Renders a ready-to-paste MCP server block **generated from the machine
 * running it**: `npx -y dsh-bridge-mcp` when this copy of the package lives
 * under `node_modules` (installed from npm), otherwise `process.execPath` plus
 * the absolute `dist/mcp.js` path. GUI harnesses also get the explicit system
 * `PATH` from `docs/install.md` §4, because a Finder/Dock launch never runs the
 * shell rc that puts node there.
 *
 * `--write` exists for exactly two harnesses:
 *
 * - `claude-code` delegates to `claude mcp add --scope user …` (printed first);
 * - `antigravity` merges into `~/.gemini/config/mcp_config.json`, after a
 *   timestamped backup, and refuses to clobber an existing `dsh-bridge` entry
 *   unless `--force` is given.
 *
 * Every other harness prints only. No other config file is ever written.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SetupError } from './errors.js';

/** Harnesses `setup` knows by name. */
export const HARNESSES = [
  'claude-code',
  'antigravity',
  'codex',
  'cursor',
  'cline',
  'continue',
  'zed',
  'raw',
] as const;

export type Harness = (typeof HARNESSES)[number];

export function isHarness(value: string | undefined): value is Harness {
  return value !== undefined && (HARNESSES as readonly string[]).includes(value);
}

/** MCP server name used everywhere (matches the docs and the MCP server name). */
export const SERVER_KEY = 'dsh-bridge';

export type ConfigFormat = 'json' | 'toml' | 'yaml';

interface HarnessInfo {
  label: string;
  /** Where the block goes, written portably (no machine paths). */
  destination: string;
  format: ConfigFormat;
  /** GUI apps do not inherit the shell `PATH` (docs/install.md §4). */
  guiApp: boolean;
  write: 'claude-cli' | 'antigravity-json' | null;
  /** One line: what was verified, and what was not. */
  verification: string;
}

const HARNESS_INFO: Record<Harness, HarnessInfo> = {
  'claude-code': {
    label: 'Claude Code',
    destination: 'user scope: ~/.claude.json under "mcpServers"; project scope: .mcp.json',
    format: 'json',
    guiApp: false,
    write: 'claude-cli',
    verification:
      'verified: `claude mcp add` was exercised against a fake `claude` executable and its output ' +
      'is the JSON block shown; no real Claude config was touched here.',
  },
  antigravity: {
    label: 'Antigravity',
    destination: '~/.gemini/config/mcp_config.json under "mcpServers"',
    format: 'json',
    guiApp: true,
    write: 'antigravity-json',
    verification:
      'the merge, backup, and --force refusal were verified against a temp HOME; the block matches ' +
      "the dsh-bridge entry already present in this machine's Antigravity config, but Antigravity " +
      'itself was not launched to watch it connect.',
  },
  codex: {
    label: 'Codex CLI',
    destination: '~/.codex/config.toml as [mcp_servers.dsh-bridge]',
    format: 'toml',
    guiApp: false,
    write: null,
    verification:
      "the TOML shape (command/args/env) follows OpenAI's MCP configuration; it was not run " +
      'against a Codex install here (none present).',
  },
  cursor: {
    label: 'Cursor',
    destination: 'global: ~/.cursor/mcp.json, project: .cursor/mcp.json — both under "mcpServers"',
    format: 'json',
    guiApp: true,
    write: null,
    verification:
      "the JSON shape follows Cursor's mcp.json; it was not run against a Cursor install here " +
      '(none present).',
  },
  cline: {
    label: 'Cline',
    destination:
      '~/.cline/data/settings/cline_mcp_settings.json under "mcpServers" (VS Code extension: the ' +
      'same file under its globalStorage; CLINE_MCP_SETTINGS_PATH overrides the directory)',
    format: 'json',
    guiApp: true,
    write: null,
    verification:
      "the JSON shape (command/args/env plus disabled/autoApprove) follows Cline's MCP settings; " +
      'it was not run against a Cline install here (none present).',
  },
  continue: {
    label: 'Continue',
    destination: '~/.continue/config.yaml under the top-level mcpServers: list',
    format: 'yaml',
    guiApp: true,
    write: null,
    verification:
      "the YAML list shape follows Continue's MCP reference; it was not run against a Continue " +
      'install here (none present).',
  },
  zed: {
    label: 'Zed',
    destination: 'settings.json under "context_servers" (Zed: `zed: open settings file`)',
    format: 'json',
    guiApp: true,
    write: null,
    verification:
      "the JSON shape follows Zed's current MCP documentation; older Zed builds also wanted " +
      '"source": "custom", and it was not run against a Zed install here (none present).',
  },
  raw: {
    label: 'any MCP client',
    destination: "the client's stdio MCP server block",
    format: 'json',
    guiApp: false,
    write: null,
    verification:
      'generic JSON (`command`/`args`/`env`), the shape every stdio MCP client accepts; no ' +
      'specific client was verified.',
  },
};

export interface LaunchCommand {
  command: string;
  args: string[];
  /** `npx` when the package was installed from npm, else the running node binary. */
  mode: 'npx' | 'node';
}

export interface LaunchCommandOptions {
  /** Defaults to `process.argv[1]`. */
  argv1?: string;
  /** Defaults to `process.execPath`. */
  execPath?: string;
  /** Defaults to the sibling `dist/mcp.js` of this package. */
  mcpEntry?: string;
}

/** True when the executing script lives under a `node_modules` directory. */
export function installedFromNpm(argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1 === '') return false;
  return argv1.split(/[\\/]+/).includes('node_modules');
}

/** Absolute path of `dist/mcp.js` for this checkout/install. */
export function defaultMcpEntry(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    if (existsSync(join(dir, 'package.json'))) return join(dir, 'dist', 'mcp.js');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(dirname(fileURLToPath(import.meta.url)), 'mcp.js');
}

/**
 * Generate the launch command from the running machine. npm installs prefer
 * `npx -y dsh-bridge-mcp` (the `-y` suppresses npx's interactive install
 * prompt, which a GUI harness cannot answer); source checkouts use the absolute
 * node + `dist/mcp.js` pair.
 */
export function resolveLaunchCommand(options: LaunchCommandOptions = {}): LaunchCommand {
  const argv1 = options.argv1 ?? process.argv[1];
  if (installedFromNpm(argv1)) {
    return { command: 'npx', args: ['-y', 'dsh-bridge-mcp'], mode: 'npx' };
  }
  return {
    command: options.execPath ?? process.execPath,
    args: [options.mcpEntry ?? defaultMcpEntry()],
    mode: 'node',
  };
}

/** System `PATH` for GUI harnesses; POSIX system directories, or System32. */
export function systemPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  }
  return '/usr/bin:/bin:/usr/sbin:/sbin';
}

export interface ServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ServerSpecOptions {
  from?: string;
  launch?: LaunchCommand;
  platform?: NodeJS.Platform;
}

/** The MCP server entry for one harness, with `DSH_BRIDGE_FROM` and GUI `PATH`. */
export function serverSpec(harness: Harness, options: ServerSpecOptions = {}): ServerSpec {
  const launch = options.launch ?? resolveLaunchCommand();
  const spec: ServerSpec = { command: launch.command, args: [...launch.args], env: {} };
  if (HARNESS_INFO[harness].guiApp) spec.env.PATH = systemPath(options.platform);
  spec.env.DSH_BRIDGE_FROM = options.from ?? harness;
  return spec;
}

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function mcpServersBlock(spec: ServerSpec, extra: Record<string, unknown> = {}): string {
  return jsonBlock({ mcpServers: { [SERVER_KEY]: { ...spec, ...extra } } });
}

/** YAML with JSON-quoted scalars: valid YAML, and no ambiguity about spaces. */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function continueBlock(spec: ServerSpec): string {
  const lines = ['mcpServers:', `  - name: ${SERVER_KEY}`, `    command: ${yamlScalar(spec.command)}`];
  if (spec.args.length === 0) {
    lines.push('    args: []');
  } else {
    lines.push('    args:');
    for (const arg of spec.args) lines.push(`      - ${yamlScalar(arg)}`);
  }
  lines.push('    env:');
  for (const [key, value] of Object.entries(spec.env)) lines.push(`      ${key}: ${yamlScalar(value)}`);
  return lines.join('\n');
}

/** TOML: the env table is a sub-table, the form Codex's docs show. */
function codexBlock(spec: ServerSpec): string {
  const lines = [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${JSON.stringify(spec.command)}`,
    `args = [${spec.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    '',
    `[mcp_servers.${SERVER_KEY}.env]`,
  ];
  for (const [key, value] of Object.entries(spec.env)) {
    lines.push(`${key} = ${JSON.stringify(value)}`);
  }
  return lines.join('\n');
}

export function renderBlock(harness: Harness, spec: ServerSpec): string {
  switch (harness) {
    case 'antigravity':
    case 'cursor':
    case 'raw':
      return mcpServersBlock(spec);
    case 'claude-code':
      return mcpServersBlock(spec);
    case 'cline':
      return mcpServersBlock(spec, { disabled: false, autoApprove: [] });
    case 'zed':
      return jsonBlock({ context_servers: { [SERVER_KEY]: { ...spec } } });
    case 'continue':
      return continueBlock(spec);
    case 'codex':
      return codexBlock(spec);
    default:
      return mcpServersBlock(spec);
  }
}

/** Single-quote a shell word only when it needs it. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface SetupPlanOptions extends ServerSpecOptions {
  homeDir?: string;
}

export interface SetupPlan {
  harness: Harness;
  from: string;
  label: string;
  mode: LaunchCommand['mode'];
  format: ConfigFormat;
  block: string;
  destination: string;
  verification: string;
  /** Absolute `mcp_config.json` for antigravity; null for print-only harnesses. */
  writePath: string | null;
  /** Exact argv for `claude mcp add`, when the harness supports --write that way. */
  claudeCommand: string[] | null;
  /** Human sentence about what `--write` does (or why it does nothing). */
  writeNote: string;
  spec: ServerSpec;
}

/** Build everything `setup` needs, without touching the filesystem. */
export function planSetup(harness: Harness, options: SetupPlanOptions = {}): SetupPlan {
  const launch = options.launch ?? resolveLaunchCommand();
  const from = options.from ?? harness;
  const spec = serverSpec(harness, { from, launch });
  const info = HARNESS_INFO[harness];

  let claudeCommand: string[] | null = null;
  if (info.write === 'claude-cli') {
    claudeCommand = [
      'mcp',
      'add',
      '--scope',
      'user',
      SERVER_KEY,
      ...Object.entries(spec.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      '--',
      spec.command,
      ...spec.args,
    ];
  }

  const writePath =
    info.write === 'antigravity-json'
      ? join(options.homeDir ?? homedir(), '.gemini', 'config', 'mcp_config.json')
      : null;

  let writeNote: string;
  if (info.write === 'claude-cli') {
    writeNote =
      '--write runs the `claude mcp add …` command above (scope user). ' +
      'Without --write nothing is changed.';
  } else if (info.write === 'antigravity-json') {
    writeNote =
      '--write merges this into ~/.gemini/config/mcp_config.json after a timestamped backup; ' +
      'an existing dsh-bridge entry is only replaced with --force.';
  } else {
    writeNote = `--write is not supported for ${info.label}: paste the block into the file above.`;
  }

  return {
    harness,
    from,
    label: info.label,
    mode: launch.mode,
    format: info.format,
    block: renderBlock(harness, spec),
    destination: info.destination,
    verification: info.verification,
    writePath,
    claudeCommand,
    writeNote,
    spec,
  };
}

/** One-screen text form: where it goes, the block, the command, and honesty. */
export function renderSetup(plan: SetupPlan): string {
  const lines: string[] = [`dsh-bridge setup ${plan.harness}`, ''];
  lines.push(`harness      ${plan.label}`);
  lines.push(`destination  ${plan.destination}`);
  lines.push(`sender       ${plan.from}  (DSH_BRIDGE_FROM)`);
  lines.push(
    `launch       ${
      plan.mode === 'npx'
        ? 'npx -y dsh-bridge-mcp (package installed from npm)'
        : 'this node binary + the absolute dist/mcp.js path (source checkout)'
    }`,
  );
  lines.push('', plan.block, '');
  if (plan.claudeCommand !== null) {
    lines.push('or register it from the shell (exactly what --write runs):');
    lines.push(`  ${['claude', ...plan.claudeCommand].map(shellQuote).join(' ')}`);
    lines.push('');
  }
  lines.push(`note      ${plan.verification}`);
  lines.push(plan.writeNote);
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------- writes */

export interface ClaudeRunResult {
  status: number | null;
  error?: string;
}

/** Runs `claude`; a seam for tests. */
export type ClaudeRunner = (argv: string[]) => ClaudeRunResult;

export const defaultClaudeRunner: ClaudeRunner = (argv) => {
  const result = spawnSync('claude', argv, { stdio: 'inherit', encoding: 'utf8' });
  if (result.error !== undefined) return { status: null, error: result.error.message };
  return { status: result.status };
};

/**
 * Register through Claude Code's own CLI. The caller prints the exact command
 * before calling this; a missing/failing `claude` is a `SetupError` naming the
 * printed command as the manual fallback.
 */
export function writeClaudeCode(plan: SetupPlan, runner: ClaudeRunner = defaultClaudeRunner): void {
  const argv = plan.claudeCommand;
  if (argv === null) throw new SetupError(`--write is not available for ${plan.label}`);
  const result = runner(argv);
  if (result.status === null) {
    throw new SetupError(
      `cannot run "claude": ${result.error ?? 'not found'}. Run the printed command yourself, ` +
        'or install Claude Code and retry.',
    );
  }
  if (result.status !== 0) {
    throw new SetupError(
      `"claude mcp add" exited with status ${String(result.status)}; nothing was changed. ` +
        'Run the printed command yourself to see its output.',
    );
  }
}

export interface AntigravityWriteOptions {
  homeDir?: string;
  force?: boolean;
  now?: Date;
  /** Override for tests; defaults to `<homeDir>/.gemini/config/mcp_config.json`. */
  path?: string;
}

export interface AntigravityWriteResult {
  path: string;
  /** Backup path when the file already existed; null when it was created fresh. */
  backup: string | null;
  /** True when an existing `dsh-bridge` entry was replaced (--force). */
  replaced: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `20261123T140102Z` — filesystem-safe, sortable, unambiguous. */
export function backupStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/**
 * Merge the block into Antigravity's global `mcp_config.json`.
 *
 * Safety order: parse (refuse to touch a file we cannot read), back up, refuse
 * to clobber an existing entry without `--force`, then write through a temp
 * file + rename so a crash cannot leave half a config.
 */
export function writeAntigravity(
  plan: SetupPlan,
  options: AntigravityWriteOptions = {},
): AntigravityWriteResult {
  const path =
    options.path ?? join(options.homeDir ?? homedir(), '.gemini', 'config', 'mcp_config.json');
  const exists = existsSync(path);

  let root: Record<string, unknown> = {};
  if (exists) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new SetupError(
        `${path} is not valid JSON (${(error as Error).message}); fix or move it, then retry. ` +
          'Nothing was written.',
      );
    }
    const record = asRecord(parsed);
    if (record === undefined) {
      throw new SetupError(
        `${path} must contain a JSON object; nothing was written. Fix or move it, then retry.`,
      );
    }
    root = record;
  }

  const existingServers = root.mcpServers;
  let servers: Record<string, unknown> = {};
  if (existingServers !== undefined) {
    const record = asRecord(existingServers);
    if (record === undefined) {
      throw new SetupError(
        `${path}: "mcpServers" must be a JSON object; nothing was written. Fix it, then retry.`,
      );
    }
    servers = record;
  }

  const replaced = Object.hasOwn(servers, SERVER_KEY);
  if (replaced && options.force !== true) {
    throw new SetupError(
      `${path} already has a "${SERVER_KEY}" entry. Re-run with --force to replace it ` +
        '(a timestamped backup is taken first). Nothing was written.',
    );
  }

  let backup: string | null = null;
  if (exists) {
    backup = `${path}.bak-dsh-bridge-mcp-${backupStamp(options.now ?? new Date())}`;
    copyFileSync(path, backup);
  }

  const merged = { ...root, mcpServers: { ...servers, [SERVER_KEY]: plan.spec } };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-dsh-bridge-mcp`;
  writeFileSync(temporary, `${jsonBlock(merged)}\n`, 'utf8');
  renameSync(temporary, path);
  return { path, backup, replaced };
}
