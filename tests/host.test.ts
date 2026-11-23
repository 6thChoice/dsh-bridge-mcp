import assert from 'node:assert/strict';
import test from 'node:test';
import { HostEndpoint, parseLsofListeners, unwrapResponse } from '../src/host.js';
import { ProtocolError, RpcError } from '../src/errors.js';

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

test('parseLsofListeners keeps loopback listeners and skips wildcards', () => {
  const output = `COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node       2314 zxc    13u  IPv4 0x1      0t0  TCP 127.0.0.1:3456 (LISTEN)
ControlCe   728 zxc    12u  IPv4 0x2      0t0  TCP *:5000 (LISTEN)
rapportd    664 zxc     9u  IPv6 0x3      0t0  TCP [::1]:53871 (LISTEN)
node       2314 zxc    14u  IPv4 0x4      0t0  TCP 127.0.0.1:3080 (LISTEN)
`;
  const sockets = parseLsofListeners(output);
  assert.equal(sockets.size, 3);
  assert.equal(sockets.get(3456)?.pid, 2314);
  assert.equal(sockets.get(3080)?.pid, 2314);
  assert.equal(sockets.get(53871)?.pid, 664);
  assert.equal(sockets.has(5000), false);
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
