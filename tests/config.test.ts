import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CONFIG_KEYS,
  configFilePath,
  expandHome,
  loadConfig,
  parseConfig,
  resolveDshHome,
} from '../src/config.js';
import { ConfigError } from '../src/errors.js';

function tempDir(prefix = 'dsh-bridge-config-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('configFilePath honours an absolute XDG_CONFIG_HOME and ignores a relative one', () => {
  assert.equal(
    configFilePath({ env: { XDG_CONFIG_HOME: '/tmp/xdg' }, homeDir: '/home/u' }),
    join('/tmp/xdg', 'dsh-bridge', 'config.json'),
  );
  assert.equal(
    configFilePath({ env: {}, homeDir: '/home/u' }),
    join('/home/u', '.config', 'dsh-bridge', 'config.json'),
  );
  // The XDG spec says a relative XDG_CONFIG_HOME is invalid: fall back.
  assert.equal(
    configFilePath({ env: { XDG_CONFIG_HOME: 'relative/dir' }, homeDir: '/home/u' }),
    join('/home/u', '.config', 'dsh-bridge', 'config.json'),
  );
});

test('expandHome expands only a leading ~, not ~user or embedded tildes', () => {
  const home = join(tmpdir(), 'home-fixture');
  assert.equal(expandHome('~', home), home);
  assert.equal(expandHome('~/.dsh', home), join(home, '.dsh'));
  assert.equal(expandHome('~/.dsh/../other', home), join(home, 'other'));
  assert.equal(expandHome('/absolute/.dsh', home), '/absolute/.dsh');
  assert.equal(expandHome('relative/.dsh', home), 'relative/.dsh');
  assert.equal(expandHome('~someone/.dsh', home), '~someone/.dsh');
});

test('parseConfig accepts exactly url, host, and dshHome as strings', () => {
  assert.deepEqual(CONFIG_KEYS, ['url', 'host', 'dshHome']);
  assert.deepEqual(
    parseConfig(
      JSON.stringify({
        url: 'http://127.0.0.1:49904/?token=fake',
        host: 'http://127.0.0.1:49904',
        dshHome: '~/.dsh',
      }),
      '/x/config.json',
    ),
    {
      url: 'http://127.0.0.1:49904/?token=fake',
      host: 'http://127.0.0.1:49904',
      dshHome: '~/.dsh',
    },
  );
  assert.deepEqual(parseConfig('{}', '/x/config.json'), {});
});

test('bad JSON is a loud ConfigError naming the file', () => {
  assert.throws(
    () => parseConfig('{ not json', '/x/config.json'),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes('/x/config.json') &&
      error.message.includes('not valid JSON'),
  );
});

test('unknown keys are rejected, not silently dropped', () => {
  assert.throws(
    () => parseConfig(JSON.stringify({ host: 'http://h', urll: 'typo' }), '/x/config.json'),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes('/x/config.json') &&
      error.message.includes('unknown key(s) "urll"') &&
      error.message.includes('url, host, dshHome'),
  );
});

test('non-object and non-string values are rejected with the key name', () => {
  assert.throws(() => parseConfig('[]', '/x/config.json'), /must contain a JSON object/);
  assert.throws(() => parseConfig('null', '/x/config.json'), /must contain a JSON object/);
  assert.throws(
    () => parseConfig(JSON.stringify({ host: 49904 }), '/x/config.json'),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes('"host" must be a non-empty string'),
  );
  assert.throws(
    () => parseConfig(JSON.stringify({ dshHome: '   ' }), '/x/config.json'),
    /"dshHome" must be a non-empty string/,
  );
});

test('a missing config file is not an error; a malformed one names the path', () => {
  const fixture = tempDir();
  try {
    const missing = join(fixture.dir, 'absent.json');
    assert.deepEqual(loadConfig({ path: missing }), { path: missing, config: undefined });

    const broken = join(fixture.dir, 'broken.json');
    writeFileSync(broken, '{"host": }', 'utf8');
    assert.throws(
      () => loadConfig({ path: broken }),
      (error: unknown) => error instanceof ConfigError && error.message.includes(broken),
    );
  } finally {
    fixture.cleanup();
  }
});

test('loadConfig finds the file under XDG_CONFIG_HOME', () => {
  const fixture = tempDir();
  try {
    const configDir = join(fixture.dir, 'dsh-bridge');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ host: 'http://127.0.0.1:1' }));
    const loaded = loadConfig({ env: { XDG_CONFIG_HOME: fixture.dir }, homeDir: '/home/u' });
    assert.equal(loaded.path, join(fixture.dir, 'dsh-bridge', 'config.json'));
    assert.deepEqual(loaded.config, { host: 'http://127.0.0.1:1' });
  } finally {
    fixture.cleanup();
  }
});

test('DSH home ladder is flag -> DSH_HOME -> config dshHome -> ~/.dsh', () => {
  const homeDir = join(tmpdir(), 'home-fixture');
  assert.equal(
    resolveDshHome({
      flag: '/flag',
      env: { DSH_HOME: '/env' },
      config: { dshHome: '/config' },
      homeDir,
    }),
    '/flag',
  );
  assert.equal(
    resolveDshHome({ env: { DSH_HOME: '/env' }, config: { dshHome: '/config' }, homeDir }),
    '/env',
  );
  assert.equal(
    resolveDshHome({ env: {}, config: { dshHome: '~/config-dsh' }, homeDir }),
    join(homeDir, 'config-dsh'),
  );
  assert.equal(resolveDshHome({ env: {}, homeDir }), join(homeDir, '.dsh'));
});
