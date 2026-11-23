import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HostEndpoint,
  discoverLoopbackCandidates,
  parseLsofListeners,
  parseSsListeners,
  parseWindowsListeners,
  platformProbes,
  resolveHost,
  ssProbe,
  unwrapResponse,
  windowsProbe,
  type DiscoveryProbe,
} from '../src/host.js';
import { ConfigError, HostError, ProtocolError, RpcError } from '../src/errors.js';

/* ---------------------------------------------------------- endpoint / RPC */

test('HostEndpoint normalizes URL and bare authority forms', () => {
  const fromUrl = new HostEndpoint('http://127.0.0.1:49904/');
  assert.equal(fromUrl.origin, 'http://127.0.0.1:49904');
  assert.equal(fromUrl.authority, '127.0.0.1:49904');
  assert.equal(fromUrl.wsOrigin, 'ws://127.0.0.1:49904');
  assert.equal(new HostEndpoint('127.0.0.1:49904').origin, 'http://127.0.0.1:49904');
  assert.equal(new HostEndpoint('https://example.test').wsOrigin, 'wss://example.test');
});

test('HostEndpoint rejects paths, unknown protocols, and garbage', () => {
  assert.throws(() => new HostEndpoint('http://127.0.0.1:1/api'), /origin/);
  assert.throws(() => new HostEndpoint('ftp://127.0.0.1:1'), /protocol/);
  assert.throws(() => new HostEndpoint(''), /empty host/);
});

test('unwrapResponse validates envelope, rpcId, and result.ok', () => {
  const ok = { type: 'server-response', rpcId: 'r1', result: { ok: true, value: { items: [] } } };
  assert.deepEqual(unwrapResponse(ok, 'session/list', 'r1', 'http://h'), { items: [] });

  assert.throws(
    () => unwrapResponse({ ...ok, type: 'nope' }, 'session/list', 'r1', 'http://h'),
    (error: unknown) => error instanceof ProtocolError && error.message.includes('server-response'),
  );
  assert.throws(
    () => unwrapResponse({ ...ok, rpcId: 'other' }, 'session/list', 'r1', 'http://h'),
    /does not match/,
  );
  assert.throws(
    () =>
      unwrapResponse(
        { type: 'server-response', rpcId: 'r1', result: { ok: false, code: 'gateway/x', message: 'bad' } },
        'session/page',
        'r1',
        'http://h',
      ),
    (error: unknown) =>
      error instanceof RpcError && error.code === 'gateway/x' && error.message.includes('session/page'),
  );
  // 0.1.x hosts nest the error under result.error.
  assert.throws(
    () =>
      unwrapResponse(
        {
          type: 'server-response',
          rpcId: 'r1',
          result: {
            ok: false,
            error: { code: 'session/agent-busy', message: 'parent required', details: { reason: 'x' } },
          },
        },
        'session/page',
        'r1',
        'http://h',
      ),
    (error: unknown) =>
      error instanceof RpcError &&
      error.code === 'session/agent-busy' &&
      error.message.includes('parent required'),
  );
  assert.throws(
    () => unwrapResponse({ type: 'server-response', rpcId: 'r1', result: {} }, 'session/list', 'r1', 'http://h'),
    /ok must be true or false/,
  );
});

/* --------------------------------------------------------------- parsers */

test('parseLsofListeners keeps loopback listeners and skips wildcards', () => {
  const output = `COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node       2314 me     13u  IPv4 0x1      0t0  TCP 127.0.0.1:3456 (LISTEN)
ControlCe   728 me     12u  IPv4 0x2      0t0  TCP *:5000 (LISTEN)
rapportd    664 me      9u  IPv6 0x3      0t0  TCP [::1]:53871 (LISTEN)
node       2314 me     14u  IPv4 0x4      0t0  TCP 127.0.0.1:3080 (LISTEN)
`;
  const sockets = parseLsofListeners(output);
  assert.equal(sockets.size, 3);
  assert.equal(sockets.get(3456)?.pid, 2314);
  assert.equal(sockets.get(3080)?.pid, 2314);
  assert.equal(sockets.get(53871)?.pid, 664);
  assert.equal(sockets.has(5000), false);
});

test('parseSsListeners reads loopback listeners with pids and skips the rest', () => {
  const output = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      4096   127.0.0.1:49904       0.0.0.0:*     users:(("node",pid=2314,fd=20))
LISTEN 0      4096   [::1]:53871           [::]:*        users:(("rapportd",pid=664,fd=9))
LISTEN 0      4096   0.0.0.0:80            0.0.0.0:*     users:(("nginx",pid=1,fd=6))
LISTEN 0      4096   127.0.0.1:7000        0.0.0.0:*     users:(("node",fd=6))
`;
  const sockets = parseSsListeners(output);
  assert.equal(sockets.size, 2);
  assert.equal(sockets.get(49904)?.pid, 2314);
  assert.equal(sockets.get(49904)?.command, 'node');
  assert.equal(sockets.get(53871)?.pid, 664);
  // No pid (another user's process) cannot be attributed, so it is dropped.
  assert.equal(sockets.has(7000), false);
  assert.equal(sockets.has(80), false);
});

test('parseWindowsListeners accepts both ConvertTo-Json shapes and filters loopback', () => {
  const many = JSON.stringify([
    { Address: '127.0.0.1', Port: 49904, Pid: 2314, Command: 'dsh.exe web --no-open' },
    { Address: '::1', Port: 53871, Pid: 664, Command: 'node dsh web' },
    { Address: '0.0.0.0', Port: 80, Pid: 1, Command: 'nginx.exe' },
  ]);
  const sockets = parseWindowsListeners(many);
  assert.equal(sockets.size, 2);
  assert.equal(sockets.get(49904)?.pid, 2314);
  assert.equal(sockets.get(53871)?.pid, 664);
  assert.equal(sockets.has(80), false);

  // A single-element pipeline is unwrapped into an object, not an array.
  const one = parseWindowsListeners(
    JSON.stringify({ Address: '127.0.0.1', Port: 3000, Pid: 7, Command: 'node dsh web' }),
  );
  assert.equal(one.get(3000)?.pid, 7);
  assert.equal(parseWindowsListeners('').size, 0);
  assert.equal(parseWindowsListeners('null').size, 0);
  assert.equal(parseWindowsListeners('not json').size, 0);
});

/* ------------------------------------------------------------- projections */

test('Linux tries ss then lsof; Windows tries Get-NetTCPConnection; macOS lsof', () => {
  assert.deepEqual(platformProbes('darwin').map((probe) => probe.name), ['lsof']);
  assert.deepEqual(platformProbes('linux').map((probe) => probe.name), ['ss', 'lsof']);
  assert.deepEqual(platformProbes('win32').map((probe) => probe.name), ['Get-NetTCPConnection']);
  assert.deepEqual(platformProbes('freebsd'), []);
});

test('ss probe turns listeners into confirmed-candidate endpoints via ps command lines', () => {
  const ssOutput = `State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0 4096 127.0.0.1:49904 0.0.0.0:* users:(("node",pid=2314,fd=20))
LISTEN 0 4096 [::1]:53871 [::]:* users:(("rapportd",pid=664,fd=9))
`;
  const probe = ssProbe({
    runner: (command) => {
      if (command.file === 'ss') return ssOutput;
      if (command.file === 'ps') {
        assert.deepEqual(command.args, ['-p', '2314,664', '-o', 'pid=,command=']);
        return ' 2314 dsh web --no-open --port 0\n  664 rapportd\n';
      }
      throw new Error(`unexpected command ${command.file}`);
    },
  });
  const endpoints = probe.run().map((endpoint) => endpoint.origin);
  assert.deepEqual(endpoints, ['http://127.0.0.1:49904']);
});

test('Windows probe recognizes a dsh command line and opens no other listener', () => {
  const probe = windowsProbe({
    runner: () => {
      return JSON.stringify([
        { Address: '127.0.0.1', Port: 49904, Pid: 42, Command: 'dsh.exe web --no-open' },
        { Address: '127.0.0.1', Port: 5000, Pid: 43, Command: 'ControlCenter.exe' },
      ]);
    },
  });
  assert.deepEqual(probe.run().map((endpoint) => endpoint.origin), ['http://127.0.0.1:49904']);
});

/* ------------------------------------------------------- discovery ladder */

test('discovery runs platform probes in order and returns the first non-empty list', () => {
  const calls: string[] = [];
  const probes: DiscoveryProbe[] = [
    {
      name: 'fake-ss',
      detail: 'ss -ltnp',
      run() {
        calls.push('fake-ss');
        return [];
      },
    },
    {
      name: 'fake-lsof',
      detail: 'lsof -nP',
      run() {
        calls.push('fake-lsof');
        throw new Error('spawnSync lsof ENOENT');
      },
    },
    {
      name: 'fake-third',
      detail: 'fake --third',
      run() {
        calls.push('fake-third');
        return [new HostEndpoint('http://127.0.0.1:5678')];
      },
    },
  ];
  const candidates = discoverLoopbackCandidates({ platform: 'linux', probes, caller: 'cli' });
  assert.deepEqual(calls, ['fake-ss', 'fake-lsof', 'fake-third']);
  assert.deepEqual(candidates.map((endpoint) => endpoint.origin), ['http://127.0.0.1:5678']);
});

test('discovery failure names the platform, every probe tried, and the CLI fix', () => {
  const probes: DiscoveryProbe[] = [
    {
      name: 'ss',
      detail: 'ss -ltnp',
      run() {
        throw new Error('spawnSync ss ENOENT');
      },
    },
    { name: 'lsof', detail: 'lsof -nP', run: () => [] },
  ];
  assert.throws(
    () => discoverLoopbackCandidates({ platform: 'linux', probes, caller: 'cli' }),
    (error: unknown) =>
      error instanceof HostError &&
      error.message.includes('Linux (linux)') &&
      error.message.includes('ss (ss -ltnp): cannot run: spawnSync ss ENOENT') &&
      error.message.includes('lsof (lsof -nP): ran, found no matching loopback listener') &&
      error.message.includes('Pass --host http://127.0.0.1:<port>') &&
      !error.message.includes('DSH_BRIDGE_HOST'),
  );
});

test('discovery failure for the MCP server says DSH_BRIDGE_HOST, not --host', () => {
  assert.throws(
    () =>
      discoverLoopbackCandidates({
        platform: 'win32',
        caller: 'mcp',
        probes: [
          {
            name: 'Get-NetTCPConnection',
            detail: 'powershell -NoProfile -Command Get-NetTCPConnection -State Listen',
            run() {
              throw new Error('spawnSync powershell ENOENT');
            },
          },
        ],
      }),
    (error: unknown) =>
      error instanceof HostError &&
      error.message.includes('Windows (win32)') &&
      error.message.includes('DSH_BRIDGE_HOST=http://127.0.0.1:<port>') &&
      !error.message.includes('Pass --host'),
  );
});

test('a platform with no probe is an explicit error, not an empty candidate list', () => {
  assert.throws(
    () => discoverLoopbackCandidates({ platform: 'freebsd', probes: [], caller: 'cli' }),
    (error: unknown) =>
      error instanceof HostError &&
      error.message.includes('platform "freebsd"') &&
      error.message.includes('no probe is registered'),
  );
});

/* --------------------------------------------------------- resolveHost ladder */

const SECRET = Buffer.alloc(32, 5).toString('base64url');

function makeDshHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bridge-host-'));
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
  return {
    home,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('host ladder is flag -> DSH_BRIDGE_HOST -> config, with sources reported', async () => {
  const fixture = makeDshHome();
  const configDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-host-config-'));
  try {
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ host: 'http://127.0.0.1:1111' }), 'utf8');
    const env: NodeJS.ProcessEnv = { DSH_BRIDGE_HOST: 'http://127.0.0.1:2222' };
    const base = {
      dshHome: fixture.home,
      configPath,
      homeDir: fixture.home,
      env,
    };

    const fromFlag = await resolveHost({ ...base, host: 'http://127.0.0.1:3333' });
    assert.equal(fromFlag.source, 'flag');
    assert.equal(fromFlag.endpoint.origin, 'http://127.0.0.1:3333');

    const fromEnv = await resolveHost(base);
    assert.equal(fromEnv.source, 'env');
    assert.equal(fromEnv.endpoint.origin, 'http://127.0.0.1:2222');

    const fromConfig = await resolveHost({ ...base, env: {} });
    assert.equal(fromConfig.source, 'config-host');
    assert.equal(fromConfig.endpoint.origin, 'http://127.0.0.1:1111');
    assert.equal(fromConfig.configFile, configPath);
  } finally {
    fixture.cleanup();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('config url wins over config host and contributes only its origin', async () => {
  const fixture = makeDshHome();
  const configDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-host-config-'));
  try {
    const configPath = join(configDir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        url: 'http://127.0.0.1:4444/?token=not-a-real-token',
        host: 'http://127.0.0.1:5555',
      }),
      'utf8',
    );
    const resolved = await resolveHost({
      dshHome: fixture.home,
      configPath,
      homeDir: fixture.home,
      env: {},
    });
    assert.equal(resolved.source, 'config-url');
    assert.equal(resolved.endpoint.origin, 'http://127.0.0.1:4444');
  } finally {
    fixture.cleanup();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('a ~ in the config dshHome expands and selects those credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-host-home-'));
  try {
    const custom = join(root, 'custom-dsh');
    mkdirSync(custom, { recursive: true });
    writeFileSync(
      join(custom, '.credentials.yaml'),
      `version: 1
records:
  client-connection/browser-session:
    payload:
      secret: ${SECRET}
`,
      'utf8',
    );
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ dshHome: '~/custom-dsh' }), 'utf8');

    const resolved = await resolveHost({
      host: 'http://127.0.0.1:1',
      configPath,
      homeDir: root,
      env: {},
    });
    assert.equal(resolved.dshHome, custom);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discovery accepts only a candidate that passes the authenticated probe', async () => {
  const fixture = makeDshHome();
  const configPath = join(fixture.home, 'absent-config.json');
  try {
    const first = new HostEndpoint('http://127.0.0.1:1111');
    const second = new HostEndpoint('http://127.0.0.1:2222');
    const confirmed: string[] = [];
    const notes: string[] = [];
    const resolved = await resolveHost({
      dshHome: fixture.home,
      configPath,
      homeDir: fixture.home,
      env: {},
      platform: 'linux',
      probes: [{ name: 'fake', detail: 'fake --probe', run: () => [first, second] }],
      confirm: async (endpoint) => {
        confirmed.push(endpoint.origin);
        if (endpoint.origin === first.origin) throw new Error('cookie rejected (401)');
      },
      onDiscoveryNote: (note) => notes.push(note),
    });
    assert.equal(resolved.source, 'discovery');
    assert.equal(resolved.endpoint.origin, second.origin);
    assert.deepEqual(confirmed, [first.origin, second.origin]);
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? '', /did not confirm/);
  } finally {
    fixture.cleanup();
  }
});

test('unconfirmed candidates fail with the caller-specific fix', async () => {
  const fixture = makeDshHome();
  try {
    await assert.rejects(
      resolveHost({
        dshHome: fixture.home,
        configPath: join(fixture.home, 'absent-config.json'),
        homeDir: fixture.home,
        env: {},
        caller: 'mcp',
        platform: 'linux',
        probes: [
          {
            name: 'fake',
            detail: 'fake --probe',
            run: () => [new HostEndpoint('http://127.0.0.1:1111')],
          },
        ],
        confirm: async () => {
          throw new Error('session/list rejected');
        },
      }),
      (error: unknown) =>
        error instanceof HostError &&
        error.message.includes('none accepted an authenticated session/list') &&
        error.message.includes('DSH_BRIDGE_HOST=http://127.0.0.1:<port>'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a broken config file is loud even when an explicit host wins', async () => {
  const fixture = makeDshHome();
  const configDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-host-config-'));
  try {
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, '{"host": }', 'utf8');
    await assert.rejects(
      resolveHost({
        host: 'http://127.0.0.1:1',
        dshHome: fixture.home,
        configPath,
        homeDir: fixture.home,
        env: {},
      }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes(configPath) &&
        error.message.includes('not valid JSON'),
    );
  } finally {
    fixture.cleanup();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('an invalid config url never echoes its token', async () => {
  const fixture = makeDshHome();
  const configDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-host-config-'));
  try {
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ url: 'not a url?token=sekret-token' }), 'utf8');
    await assert.rejects(
      resolveHost({
        dshHome: fixture.home,
        configPath,
        homeDir: fixture.home,
        env: {},
      }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes(configPath) &&
        !error.message.includes('sekret-token'),
    );
  } finally {
    fixture.cleanup();
    rmSync(configDir, { recursive: true, force: true });
  }
});
