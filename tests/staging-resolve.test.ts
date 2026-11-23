import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import {
  MACOS_DSH_BIN,
  resolveDshBinary,
  stagingSkipReason,
} from './staging.js';

const PATH_DIRS = ['/opt/dsh/bin', '/usr/local/bin'];

function envWith(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { PATH: PATH_DIRS.join(delimiter), ...overrides };
}

test('DSH_BIN wins over PATH when it is runnable', () => {
  const onPath = join(PATH_DIRS[0] ?? '/opt/dsh/bin', 'dsh');
  const fromEnv = '/custom/bin/dsh';
  const resolution = resolveDshBinary({
    env: envWith({ DSH_BIN: fromEnv }),
    platform: 'linux',
    isRunnable: (path) => path === fromEnv || path === onPath,
  });
  assert.deepEqual(resolution, { binary: fromEnv, source: 'DSH_BIN' });
});

test('a set-but-unrunnable DSH_BIN does not fall back (self-skip instead)', () => {
  const onPath = join(PATH_DIRS[0] ?? '/opt/dsh/bin', 'dsh');
  const resolution = resolveDshBinary({
    env: envWith({ DSH_BIN: '/missing/dsh' }),
    platform: 'linux',
    isRunnable: (path) => path === onPath,
  });
  assert.equal(resolution.binary, undefined);
  assert.equal(resolution.source, 'none');
  assert.match(resolution.reason ?? '', /DSH_BIN=\/missing\/dsh is not a runnable dsh/);
});

test('without DSH_BIN, dsh on PATH is used', () => {
  const onPath = join(PATH_DIRS[1] ?? '/usr/local/bin', 'dsh');
  const resolution = resolveDshBinary({
    env: envWith({}),
    platform: 'linux',
    isRunnable: (path) => path === onPath,
  });
  assert.deepEqual(resolution, { binary: onPath, source: 'PATH' });
});

test('macOS falls back to the app bundle only after PATH has no dsh', () => {
  const resolution = resolveDshBinary({
    env: envWith({ PATH: '' }),
    platform: 'darwin',
    isRunnable: (path) => path === MACOS_DSH_BIN,
  });
  assert.deepEqual(resolution, { binary: MACOS_DSH_BIN, source: 'macOS app' });
});

test('no runnable dsh yields a self-skip reason, not a throw', () => {
  const resolution = resolveDshBinary({
    env: envWith({ PATH: '' }),
    platform: 'darwin',
    isRunnable: () => false,
  });
  assert.equal(resolution.binary, undefined);
  assert.equal(resolution.source, 'none');
  assert.match(resolution.reason ?? '', /set DSH_BIN/);
  assert.match(resolution.reason ?? '', /put dsh on PATH/);
});

test('stagingSkipReason is false when a dsh is resolvable, a message otherwise', () => {
  assert.equal(
    stagingSkipReason({
      env: { DSH_BIN: '/custom/dsh' },
      platform: 'linux',
      isRunnable: () => true,
    }),
    false,
  );
  const skip = stagingSkipReason({
    env: { DSH_BIN: '/missing/dsh' },
    platform: 'linux',
    isRunnable: () => false,
  });
  assert.notEqual(skip, false);
  assert.match(String(skip), /^staging tests skipped: DSH_BIN=\/missing\/dsh is not a runnable dsh/);
});
