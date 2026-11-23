import assert from 'node:assert/strict';
import test from 'node:test';
import { MINIMUM_NODE, isNodeVersionSupported, nodeVersionMessage } from '../src/runtime.js';

test('Node floor is 22.19.0', () => {
  assert.equal(MINIMUM_NODE, '22.19.0');
  assert.equal(isNodeVersionSupported('22.18.9'), false);
  assert.equal(isNodeVersionSupported('22.19.0'), true);
  assert.equal(isNodeVersionSupported('22.19.1'), true);
  assert.equal(isNodeVersionSupported('23.0.0'), true);
  assert.equal(isNodeVersionSupported('24.19.0'), true);
  assert.equal(isNodeVersionSupported('20.20.2'), false);
  assert.equal(isNodeVersionSupported('garbage'), false);
  assert.match(nodeVersionMessage('20.20.2'), /22\.19\.0.*20\.20\.2/);
});
