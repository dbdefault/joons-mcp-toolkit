import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHostRouter,
  HostUnavailableError,
  UnknownDeliveryError,
} from '../src/host-router.mjs';
import {
  HostUnavailableError as CoreHostUnavailableError,
  UnknownDeliveryError as CoreUnknownDeliveryError,
} from '../src/router.mjs';

test('(a) explicit unavailable or unknown target never invokes', async () => {
  const calls = [];
  const r = createHostRouter({
    hosts: ['host-a', 'host-b'],
    isAvailable: async (id) => id === 'host-b',
    invoke: async (id) => {
      calls.push(id);
      return id;
    },
  });
  await assert.rejects(r.call({ op: 1 }, { targetHost: 'host-a' }), HostUnavailableError);
  await assert.rejects(r.call({ op: 1 }, { targetHost: 'host-z' }), HostUnavailableError);
  assert.deepEqual(calls, []);
});

test('(b) automatic selection skips unavailable hosts in list order', async () => {
  const calls = [];
  const r = createHostRouter({
    hosts: ['host-a', 'host-b', 'host-c'],
    isAvailable: async (id) => id !== 'host-a',
    invoke: async (id) => {
      calls.push(id);
      return id;
    },
  });
  assert.equal(await r.call({ op: 'ping' }), 'host-b');
  assert.deepEqual(calls, ['host-b']);
});

test('(c) invoke error with phase=before_send still UnknownDeliveryError and no fallback', async () => {
  const calls = [];
  const r = createHostRouter({
    hosts: ['host-a', 'host-b'],
    isAvailable: async () => true,
    invoke: async (id) => {
      calls.push(id);
      const err = new Error('connect refused');
      err.phase = 'before_send';
      throw err;
    },
  });
  await assert.rejects(r.call({ op: 1 }), UnknownDeliveryError);
  assert.deepEqual(calls, ['host-a']);
});

test('(d) UnknownDeliveryError preserves original cause', async () => {
  const original = new Error('timeout-marker');
  original.phase = 'before_send';
  const r = createHostRouter({
    hosts: ['host-a', 'host-b'],
    isAvailable: async () => true,
    invoke: async () => {
      throw original;
    },
  });
  await assert.rejects(
    r.call({ op: 1 }),
    (err) => err instanceof UnknownDeliveryError && err.cause === original,
  );
});

test('(e) duplicate id, empty id, or non-function adapters throw TypeError', () => {
  assert.throws(
    () => createHostRouter({ hosts: ['host-a', 'host-a'], isAvailable: () => true, invoke: async () => 1 }),
    TypeError,
  );
  assert.throws(
    () => createHostRouter({ hosts: [''], isAvailable: () => true, invoke: async () => 1 }),
    TypeError,
  );
  assert.throws(
    () => createHostRouter({ hosts: ['host-a'], isAvailable: null, invoke: async () => 1 }),
    TypeError,
  );
  assert.throws(
    () => createHostRouter({ hosts: ['host-a'], isAvailable: () => true, invoke: null }),
    TypeError,
  );
});

test('(f) repeated call with same operation always invokes (no core dedupe)', async () => {
  let n = 0;
  const r = createHostRouter({
    hosts: ['host-a'],
    isAvailable: async () => true,
    invoke: async () => {
      n += 1;
      return n;
    },
  });
  assert.equal(await r.call({ same: true }), 1);
  assert.equal(await r.call({ same: true }), 2);
  assert.equal(await r.call({ same: true }), 3);
  assert.equal(n, 3);
});

test('(g) error class instanceof matches core re-exports', async () => {
  const r = createHostRouter({
    hosts: ['host-a'],
    isAvailable: async () => false,
    invoke: async () => 1,
  });
  try {
    await r.call({}, { targetHost: 'host-a' });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err instanceof HostUnavailableError, true);
    assert.equal(err instanceof CoreHostUnavailableError, true);
  }

  const r2 = createHostRouter({
    hosts: ['host-a', 'host-b'],
    isAvailable: async () => true,
    invoke: async () => {
      throw new Error('x');
    },
  });
  try {
    await r2.call({});
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err instanceof UnknownDeliveryError, true);
    assert.equal(err instanceof CoreUnknownDeliveryError, true);
  }
});
