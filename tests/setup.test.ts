/**
 * `dsh-bridge setup` (release contract: "New commands").
 *
 * Rendering is tested for every harness against a fixed launch command, so the
 * blocks are deterministic and contain no path from this machine. The two
 * `--write` paths are tested against a temp `HOME` and a fake `claude`
 * executable: no real harness config is ever touched.
 */

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import {
  HARNESSES,
  backupStamp,
  defaultMcpEntry,
  installedFromNpm,
  isHarness,
  planSetup,
  renderSetup,
  resolveLaunchCommand,
  shellQuote,
  writeAntigravity,
  writeClaudeCode,
} from '../src/setup.js';
import { SetupError } from '../src/errors.js';
import { runCli } from './staging.js';

const LAUNCH = {
  command: '/opt/test-node/bin/node',
  args: ['/opt/test-node/lib/dsh-bridge-mcp/dist/mcp.js'],
  mode: 'node' as const,
};

function tempDir(prefix = 'dsh-bridge-setup-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/* --------------------------------------------------------------- rendering */

test('every harness renders a block with the launch command, env, and its own destination', () => {
  for (const harness of HARNESSES) {
    const plan = planSetup(harness, { launch: LAUNCH });
    assert.equal(plan.from, harness);
    assert.match(plan.destination, /\S/);
    assert.match(plan.verification, /verified|not run|no specific client|exercised/);
    assert.ok(plan.block.includes(LAUNCH.command), `${harness}: command`);
    assert.ok(plan.block.includes(LAUNCH.args[0] ?? ''), `${harness}: arg`);
    assert.ok(plan.block.includes(`DSH_BRIDGE_FROM`), `${harness}: sender`);
    if (plan.format === 'json') {
      const parsed = JSON.parse(plan.block) as Record<string, unknown>;
      assert.ok('mcpServers' in parsed || 'context_servers' in parsed, harness);
    }
  }
});

test('JSON harnesses use the documented wrappers and GUI harnesses get the system PATH', () => {
  const claude = JSON.parse(planSetup('claude-code', { launch: LAUNCH }).block) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const entry = claude.mcpServers['dsh-bridge'];
  assert.equal(entry?.command, LAUNCH.command);
  assert.deepEqual(entry?.args, LAUNCH.args);
  assert.deepEqual(entry?.env, { DSH_BRIDGE_FROM: 'claude-code' });

  const cursor = JSON.parse(planSetup('cursor', { launch: LAUNCH }).block) as typeof claude;
  assert.deepEqual(cursor.mcpServers['dsh-bridge']?.env, {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    DSH_BRIDGE_FROM: 'cursor',
  });

  const cline = JSON.parse(planSetup('cline', { launch: LAUNCH }).block) as {
    mcpServers: Record<string, { disabled?: boolean; autoApprove?: unknown[] }>;
  };
  assert.equal(cline.mcpServers['dsh-bridge']?.disabled, false);
  assert.deepEqual(cline.mcpServers['dsh-bridge']?.autoApprove, []);

  const zed = JSON.parse(planSetup('zed', { launch: LAUNCH }).block) as {
    context_servers: Record<string, { command: string; env: Record<string, string> }>;
  };
  assert.equal(zed.context_servers['dsh-bridge']?.command, LAUNCH.command);
  assert.equal(zed.context_servers['dsh-bridge']?.env.DSH_BRIDGE_FROM, 'zed');
  // Current Zed docs show command/args/env directly (older builds wanted source: custom).
  assert.equal('source' in (zed.context_servers['dsh-bridge'] ?? {}), false);

  const raw = JSON.parse(planSetup('raw', { launch: LAUNCH }).block) as typeof claude;
  assert.equal(raw.mcpServers['dsh-bridge']?.command, LAUNCH.command);
  assert.equal(raw.mcpServers['dsh-bridge']?.env.PATH, undefined);
});

test('codex renders TOML and continue renders a YAML list', () => {
  const codex = planSetup('codex', { launch: LAUNCH }).block;
  assert.match(codex, /^\[mcp_servers\.dsh-bridge\]$/m);
  assert.match(codex, /^command = "\/opt\/test-node\/bin\/node"$/m);
  assert.match(codex, /^args = \["\/opt\/test-node\/lib\/dsh-bridge-mcp\/dist\/mcp\.js"\]$/m);
  assert.match(codex, /^\[mcp_servers\.dsh-bridge\.env\]$/m);
  assert.match(codex, /^DSH_BRIDGE_FROM = "codex"$/m);

  const continueConfig = planSetup('continue', { launch: LAUNCH }).block;
  assert.match(continueConfig, /^mcpServers:$/m);
  assert.match(continueConfig, /^ {2}- name: dsh-bridge$/m);
  assert.match(continueConfig, /^ {4}command: "\/opt\/test-node\/bin\/node"$/m);
  assert.match(continueConfig, /^ {6}- "\/opt\/test-node\/lib\/dsh-bridge-mcp\/dist\/mcp\.js"$/m);
  assert.match(continueConfig, /^ {6}DSH_BRIDGE_FROM: "continue"$/m);
});

test('--from overrides DSH_BRIDGE_FROM in every harness', () => {
  for (const harness of HARNESSES) {
    const plan = planSetup(harness, { launch: LAUNCH, from: 'my-agent' });
    assert.equal(plan.from, 'my-agent');
    assert.ok(plan.block.includes('my-agent'), harness);
    assert.ok(!plan.block.includes(`"${harness}"`), `${harness} should not keep its default sender`);
  }
});

test('claude-code also prints the exact `claude mcp add` command --write runs', () => {
  const plan = planSetup('claude-code', { launch: LAUNCH });
  assert.deepEqual(plan.claudeCommand, [
    'mcp',
    'add',
    '--scope',
    'user',
    'dsh-bridge',
    '-e',
    'DSH_BRIDGE_FROM=claude-code',
    '--',
    LAUNCH.command,
    LAUNCH.args[0],
  ]);
  const text = renderSetup(plan);
  assert.match(text, /claude mcp add --scope user dsh-bridge -e DSH_BRIDGE_FROM=claude-code/);
  assert.match(text, /--write runs/);
});

test('print-only harnesses say so instead of promising a write', () => {
  for (const harness of HARNESSES) {
    const plan = planSetup(harness, { launch: LAUNCH });
    const supportsWrite = harness === 'claude-code' || harness === 'antigravity';
    if (supportsWrite) continue;
    assert.match(plan.writeNote, /--write is not supported/);
    assert.equal(plan.writePath, null);
    assert.equal(plan.claudeCommand, null);
  }
});

test('shellQuote keeps simple words bare and quotes paths with spaces', () => {
  assert.equal(shellQuote('/usr/bin/node'), '/usr/bin/node');
  assert.equal(shellQuote('/Applications/DeepSeek Harness/node'), `'/Applications/DeepSeek Harness/node'`);
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
});

/* ------------------------------------------------------------ npm detection */

test('installedFromNpm detects a node_modules entry path on every separator', () => {
  assert.equal(installedFromNpm('/usr/local/lib/node_modules/dsh-bridge-mcp/dist/cli.js'), true);
  assert.equal(installedFromNpm('C:\\app\\npm\\node_modules\\dsh-bridge-mcp\\dist\\cli.js'), true);
  assert.equal(installedFromNpm('/home/dev/code/dsh-bridge/dist/cli.js'), false);
  assert.equal(installedFromNpm(undefined), false);
  assert.equal(installedFromNpm(''), false);
});

test('resolveLaunchCommand prefers npx for npm installs and node+dist/mcp.js otherwise', () => {
  const npm = resolveLaunchCommand({
    argv1: '/usr/local/lib/node_modules/dsh-bridge-mcp/dist/cli.js',
    execPath: '/usr/local/bin/node',
    mcpEntry: '/usr/local/lib/node_modules/dsh-bridge-mcp/dist/mcp.js',
  });
  assert.deepEqual(npm, { command: 'npx', args: ['-y', 'dsh-bridge-mcp'], mode: 'npx' });

  const local = resolveLaunchCommand({
    argv1: '/repo/dist/cli.js',
    execPath: '/usr/local/bin/node',
    mcpEntry: '/repo/dist/mcp.js',
  });
  assert.deepEqual(local, {
    command: '/usr/local/bin/node',
    args: ['/repo/dist/mcp.js'],
    mode: 'node',
  });
});

test('defaultMcpEntry resolves the dist/mcp.js of this package', () => {
  const entry = defaultMcpEntry();
  assert.ok(entry.endsWith(join('dist', 'mcp.js')), entry);
  assert.ok(existsSync(entry), `${entry} must exist after a build`);
});

test('isHarness accepts only the documented names', () => {
  for (const harness of HARNESSES) assert.equal(isHarness(harness), true);
  assert.equal(isHarness('claude'), false);
  assert.equal(isHarness(undefined), false);
});

/* ---------------------------------------------------- antigravity --write */

test('antigravity --write creates the file, then merges and backs it up', () => {
  const temp = tempDir();
  try {
    const first = writeAntigravity(planSetup('antigravity', { launch: LAUNCH }), {
      homeDir: temp.dir,
      now: new Date('2026-11-23T14:01:02.123Z'),
    });
    assert.equal(first.backup, null);
    assert.equal(first.replaced, false);
    assert.equal(first.path, join(temp.dir, '.gemini', 'config', 'mcp_config.json'));
    const created = JSON.parse(readFileSync(first.path, 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    assert.equal(created.mcpServers['dsh-bridge']?.command, LAUNCH.command);

    // Merge into a file that already has another server.
    writeFileSync(
      first.path,
      JSON.stringify({ mcpServers: { other: { command: 'other' } }, keep: true }, null, 2),
      'utf8',
    );
    const second = writeAntigravity(planSetup('antigravity', { launch: LAUNCH }), {
      homeDir: temp.dir,
      now: new Date('2026-11-23T15:02:03.000Z'),
    });
    assert.equal(second.backup, `${first.path}.bak-dsh-bridge-mcp-20261123T150203Z`);
    assert.ok(existsSync(second.backup ?? ''));
    const merged = JSON.parse(readFileSync(second.path, 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
      keep: boolean;
    };
    assert.equal(merged.keep, true);
    assert.equal(merged.mcpServers.other?.command, 'other');
    assert.equal(merged.mcpServers['dsh-bridge']?.command, LAUNCH.command);
  } finally {
    temp.cleanup();
  }
});

test('antigravity --write refuses to clobber without --force, and --force backs up first', () => {
  const temp = tempDir();
  try {
    const path = join(temp.dir, '.gemini', 'config', 'mcp_config.json');
    const original = JSON.stringify({ mcpServers: { 'dsh-bridge': { command: 'old' } } }, null, 2);
    mkdirSync(join(temp.dir, '.gemini', 'config'), { recursive: true });
    writeFileSync(path, original, 'utf8');

    assert.throws(
      () => writeAntigravity(planSetup('antigravity', { launch: LAUNCH }), { homeDir: temp.dir }),
      (error: unknown) =>
        error instanceof SetupError &&
        error.message.includes('already has a "dsh-bridge" entry') &&
        error.message.includes('--force') &&
        error.message.includes('Nothing was written'),
    );
    // Refusal leaves the file byte-for-byte intact and takes no backup.
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.deepEqual(
      readdirSync(join(temp.dir, '.gemini', 'config')).filter((name) => name.includes('.bak-')),
      [],
    );

    const forced = writeAntigravity(planSetup('antigravity', { launch: LAUNCH }), {
      homeDir: temp.dir,
      force: true,
      now: new Date('2026-11-23T16:00:00.000Z'),
    });
    assert.equal(forced.replaced, true);
    assert.equal(forced.backup, `${path}.bak-dsh-bridge-mcp-20261123T160000Z`);
    assert.equal(readFileSync(forced.backup ?? '', 'utf8'), original);
    const replaced = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    assert.equal(replaced.mcpServers['dsh-bridge']?.command, LAUNCH.command);
  } finally {
    temp.cleanup();
  }
});

test('antigravity --write refuses invalid JSON and a non-object mcpServers', () => {
  const temp = tempDir();
  try {
    const path = join(temp.dir, '.gemini', 'config', 'mcp_config.json');
    mkdirSync(join(temp.dir, '.gemini', 'config'), { recursive: true });

    writeFileSync(path, '{"mcpServers": ', 'utf8');
    assert.throws(
      () => writeAntigravity(planSetup('antigravity', { launch: LAUNCH }), { homeDir: temp.dir }),
      (error: unknown) =>
        error instanceof SetupError &&
        error.message.includes('not valid JSON') &&
        error.message.includes('Nothing was written'),
    );
    assert.equal(readFileSync(path, 'utf8'), '{"mcpServers": ');

    writeFileSync(path, JSON.stringify({ mcpServers: [] }), 'utf8');
    assert.throws(
      () => writeAntigravity(planSetup('antigravity', { launch: LAUNCH }), { homeDir: temp.dir }),
      (error: unknown) =>
        error instanceof SetupError && error.message.includes('"mcpServers" must be a JSON object'),
    );
  } finally {
    temp.cleanup();
  }
});

test('backupStamp is filesystem-safe and sortable', () => {
  assert.equal(backupStamp(new Date('2026-11-23T14:01:02.123Z')), '20261123T140102Z');
});

/* -------------------------------------------------------- claude-code --write */

test('claude-code --write delegates the exact argv and reports failures', () => {
  const plan = planSetup('claude-code', { launch: LAUNCH });
  const calls: string[][] = [];
  writeClaudeCode(plan, (argv) => {
    calls.push(argv);
    return { status: 0 };
  });
  assert.deepEqual(calls, [plan.claudeCommand]);

  assert.throws(
    () => writeClaudeCode(plan, () => ({ status: 2 })),
    (error: unknown) =>
      error instanceof SetupError && error.message.includes('exited with status 2'),
  );
  assert.throws(
    () => writeClaudeCode(plan, () => ({ status: null, error: 'spawnSync claude ENOENT' })),
    (error: unknown) =>
      error instanceof SetupError &&
      error.message.includes('cannot run "claude"') &&
      error.message.includes('printed command'),
  );
});

test('the real claude-code writer spawns `claude` from PATH', () => {
  const temp = tempDir();
  const previousPath = process.env.PATH;
  try {
    const bin = join(temp.dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const capture = join(temp.dir, 'argv.txt');
    const script = join(bin, 'claude');
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`, 'utf8');
    chmodSync(script, 0o755);
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;

    writeClaudeCode(planSetup('claude-code', { launch: LAUNCH }));
    const argv = readFileSync(capture, 'utf8').trim().split('\n');
    assert.deepEqual(argv, planSetup('claude-code', { launch: LAUNCH }).claudeCommand);
  } finally {
    process.env.PATH = previousPath;
    temp.cleanup();
  }
});

/* --------------------------------------------------------------- CLI wiring */

test('CLI: setup prints a block, rejects unknown harnesses, and refuses print-only --write', async () => {
  const printed = await runCli(['setup', 'codex'], { home: '' });
  assert.equal(printed.code, 0, printed.stderr);
  assert.match(printed.stdout, /dsh-bridge setup codex/);
  assert.match(printed.stdout, /\[mcp_servers\.dsh-bridge\]/);
  assert.match(printed.stdout, /--write is not supported/);

  const unknown = await runCli(['setup', 'not-a-harness'], { home: '' });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /setup needs a harness/);
  assert.match(unknown.stderr, /claude-code, antigravity/);

  const printOnly = await runCli(['setup', 'cursor', '--write'], { home: '' });
  assert.equal(printOnly.code, 1);
  assert.match(printOnly.stderr, /print-only/);

  const withJson = await runCli(['setup', 'raw', '--json'], { home: '' });
  assert.equal(withJson.code, 1);
  assert.match(withJson.stderr, /prints text only/);
});

test('CLI: setup --from lands in the block', async () => {
  const run = await runCli(['setup', 'raw', '--from', 'my-agent'], { home: '' });
  assert.equal(run.code, 0, run.stderr);
  const block = run.stdout.slice(run.stdout.indexOf('{\n'), run.stdout.lastIndexOf('\n}') + 2);
  const parsed = JSON.parse(block) as {
    mcpServers: Record<string, { env: Record<string, string> }>;
  };
  assert.equal(parsed.mcpServers['dsh-bridge']?.env.DSH_BRIDGE_FROM, 'my-agent');
});

test('CLI: antigravity --write writes only inside the temp HOME', async () => {
  const temp = tempDir();
  try {
    const run = await runCli(['setup', 'antigravity', '--write'], {
      home: '',
      env: { HOME: temp.dir },
    });
    assert.equal(run.code, 0, run.stderr);
    const path = join(temp.dir, '.gemini', 'config', 'mcp_config.json');
    assert.ok(existsSync(path), `${path} should exist`);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: Record<string, { command: string; env: Record<string, string> }>;
    };
    assert.equal(parsed.mcpServers['dsh-bridge']?.env.DSH_BRIDGE_FROM, 'antigravity');
    assert.match(run.stdout, /dsh-bridge: wrote /);

    // A second run without --force is refused, and the message says why.
    const again = await runCli(['setup', 'antigravity', '--write'], {
      home: '',
      env: { HOME: temp.dir },
    });
    assert.equal(again.code, 1);
    assert.match(again.stderr, /--force/);
  } finally {
    temp.cleanup();
  }
});

test('CLI: claude-code --write runs the printed command through PATH', async () => {
  const temp = tempDir();
  try {
    const bin = join(temp.dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const capture = join(temp.dir, 'argv.txt');
    const script = join(bin, 'claude');
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`, 'utf8');
    chmodSync(script, 0o755);
    const run = await runCli(['setup', 'claude-code', '--write'], {
      home: '',
      env: { PATH: `${bin}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}` },
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /running: claude mcp add --scope user dsh-bridge/);
    const argv = readFileSync(capture, 'utf8').trim().split('\n');
    assert.deepEqual(argv.slice(0, 3), ['mcp', 'add', '--scope']);
    assert.ok(argv.includes('DSH_BRIDGE_FROM=claude-code'));
  } finally {
    temp.cleanup();
  }
});
