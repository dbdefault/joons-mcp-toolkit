import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/router.mjs';

function host(id, opts = {}) {
  const calls = [];
  const h = {
    id,
    priority: opts.priority ?? 0,
    calls,
    isAvailable: opts.isAvailable,
    async send(request, ctx) {
      calls.push({ request, ctx });
      if (typeof opts.send === 'function') return opts.send(request, ctx, calls);
      return opts.value ?? { ok: true, id };
    },
  };
  return h;
}

function beforeSendError(message = 'connect refused') {
  const err = new Error(message);
  err.phase = 'before_send';
  return err;
}

function afterSendError(message = 'lost after dispatch') {
  const err = new Error(message);
  err.phase = 'after_send';
  return err;
}

test('rejects duplicate host ids at create time', () => {
  assert.throws(
    () => createRouter({ hosts: [host('host-a'), host('host-a')] }),
    /duplicate|id/i,
  );
});

test('rejects empty host id at create time', () => {
  assert.throws(() => createRouter({ hosts: [host('')] }), /id/i);
  assert.throws(() => createRouter({ hosts: [{ id: '   ', send: async () => ({}) }] }), /id/i);
});

test('rejects non-function send at create time', () => {
  assert.throws(() => createRouter({ hosts: [{ id: 'host-a', send: null }] }), /send/i);
});

test('(a) explicit target never falls back — down host does not call others', async () => {
  const a = host('host-a', {
    async send() {
      throw beforeSendError('host-a down');
    },
  });
  const b = host('host-b', { priority: 1 });
  const router = createRouter({ hosts: [a, b] });
  const result = await router.route({
    requestId: 'r-a1',
    request: { op: 'ping' },
    target: 'host-a',
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.host, 'host-a');
  assert.equal(b.calls.length, 0);
  assert.equal(a.calls.length, 1);
});

test('(a2) explicit target after_send failure still does not fall back', async () => {
  const a = host('host-a', {
    async send() {
      throw afterSendError();
    },
  });
  const b = host('host-b');
  const router = createRouter({ hosts: [a, b] });
  const result = await router.route({
    requestId: 'r-a2',
    request: { op: 'ping' },
    target: 'host-a',
  });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(b.calls.length, 0);
});

test('(b) unspecified target tries priority ascending then declaration order', async () => {
  const order = [];
  const low = host('host-b', {
    priority: 10,
    async send() {
      order.push('host-b');
      return { from: 'host-b' };
    },
  });
  const high = host('host-a', {
    priority: 1,
    async send() {
      order.push('host-a');
      return { from: 'host-a' };
    },
  });
  const mid = host('host-c', {
    priority: 1,
    async send() {
      order.push('host-c');
      return { from: 'host-c' };
    },
  });
  // Declaration: host-b, host-a, host-c — sorted by priority then declaration: a, c, b
  const router = createRouter({ hosts: [low, high, mid] });
  const result = await router.route({ requestId: 'r-b1', request: { op: 1 } });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.host, 'host-a');
  assert.deepEqual(order, ['host-a']);
  assert.equal(result.value.from, 'host-a');
});

test('(c) before_send failure falls back to next host', async () => {
  const a = host('host-a', {
    priority: 1,
    async send() {
      throw beforeSendError();
    },
  });
  const b = host('host-b', {
    priority: 2,
    value: { ok: true },
  });
  const router = createRouter({ hosts: [a, b] });
  const result = await router.route({ requestId: 'r-c1', request: { n: 1 } });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.host, 'host-b');
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  assert.ok(result.attempts.some((x) => x.host === 'host-a' && x.outcome === 'error'));
});

test('(c2) isAvailable false is before_send-style skip and falls back', async () => {
  const a = host('host-a', {
    priority: 1,
    isAvailable: () => false,
    async send() {
      throw new Error('should not send');
    },
  });
  const b = host('host-b', { priority: 2, value: { ok: true } });
  const router = createRouter({ hosts: [a, b] });
  const result = await router.route({ requestId: 'r-c2', request: { n: 1 } });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.host, 'host-b');
  assert.equal(a.calls.length, 0);
  assert.ok(result.attempts.some((x) => x.host === 'host-a' && x.outcome === 'skipped'));
});

test('(d) after_send error yields UNKNOWN and no further send', async () => {
  const a = host('host-a', {
    priority: 1,
    async send() {
      throw afterSendError();
    },
  });
  const b = host('host-b', { priority: 2 });
  const router = createRouter({ hosts: [a, b] });
  const result = await router.route({ requestId: 'r-d1', request: { n: 1 } });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.host, 'host-a');
  assert.equal(b.calls.length, 0);
});

test('(e) missing or unknown phase yields UNKNOWN with no fallback', async () => {
  const a = host('host-a', {
    priority: 1,
    async send() {
      throw new Error('mystery');
    },
  });
  const b = host('host-b', { priority: 2 });
  const router = createRouter({ hosts: [a, b] });
  const result = await router.route({ requestId: 'r-e1', request: { n: 1 } });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(b.calls.length, 0);

  const a2 = host('host-a', {
    priority: 1,
    async send() {
      const err = new Error('weird');
      err.phase = 'something_else';
      throw err;
    },
  });
  const b2 = host('host-b', { priority: 2 });
  const router2 = createRouter({ hosts: [a2, b2] });
  const result2 = await router2.route({ requestId: 'r-e2', request: { n: 1 } });
  assert.equal(result2.status, 'UNKNOWN');
  assert.equal(b2.calls.length, 0);
});

test('(f) timeout without phase yields UNKNOWN', async () => {
  const a = host('host-a', {
    priority: 1,
    async send() {
      const err = new Error('timeout');
      err.code = 'ETIMEDOUT';
      throw err;
    },
  });
  const b = host('host-b', { priority: 2 });
  const router = createRouter({ hosts: [a, b] });
  const result = await router.route({ requestId: 'r-f1', request: { n: 1 } });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(b.calls.length, 0);
});

test('(g) unregistered target fails without any send', async () => {
  const a = host('host-a');
  const b = host('host-b');
  const router = createRouter({ hosts: [a, b] });
  const result = await router.route({
    requestId: 'r-g1',
    request: { n: 1 },
    target: 'host-z',
  });
  assert.equal(result.status, 'FAILED');
  assert.equal(a.calls.length, 0);
  assert.equal(b.calls.length, 0);
});

test('(h) same requestId replay returns recorded result without extra send', async () => {
  const a = host('host-a', { value: { once: true } });
  const router = createRouter({ hosts: [a] });
  const first = await router.route({ requestId: 'r-h1', request: { n: 1 } });
  const second = await router.route({ requestId: 'r-h1', request: { n: 1 } });
  assert.equal(a.calls.length, 1);
  assert.deepEqual(first, second);
  assert.equal(first.status, 'SUCCEEDED');
});

test('(h2) UNKNOWN replay does not resend', async () => {
  const a = host('host-a', {
    async send() {
      throw afterSendError();
    },
  });
  const b = host('host-b');
  const router = createRouter({ hosts: [a, b] });
  const first = await router.route({ requestId: 'r-h2', request: { n: 1 } });
  const second = await router.route({ requestId: 'r-h2', request: { n: 1 } });
  assert.equal(first.status, 'UNKNOWN');
  assert.deepEqual(first, second);
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 0);
});

test('(i) same requestId with different request content conflicts', async () => {
  const a = host('host-a');
  const router = createRouter({ hosts: [a] });
  await router.route({ requestId: 'r-i1', request: { n: 1 } });
  const conflict = await router.route({ requestId: 'r-i1', request: { n: 2 } });
  assert.equal(conflict.status, 'FAILED');
  assert.match(String(conflict.error?.message ?? conflict.error), /conflict/i);
  assert.equal(a.calls.length, 1);
});

test('(j) concurrent same requestId performs send once', async () => {
  let started = 0;
  const a = host('host-a', {
    async send() {
      started++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true };
    },
  });
  const router = createRouter({ hosts: [a] });
  const [x, y] = await Promise.all([
    router.route({ requestId: 'r-j1', request: { n: 1 } }),
    router.route({ requestId: 'r-j1', request: { n: 1 } }),
  ]);
  assert.equal(started, 1);
  assert.equal(a.calls.length, 1);
  assert.deepEqual(x, y);
  assert.equal(x.status, 'SUCCEEDED');
});

test('(k) all hosts fail before send → FAILED', async () => {
  const a = host('host-a', {
    priority: 1,
    isAvailable: () => false,
  });
  const b = host('host-b', {
    priority: 2,
    async send() {
      throw beforeSendError();
    },
  });
  const router = createRouter({ hosts: [a, b] });
  const result = await router.route({ requestId: 'r-k1', request: { n: 1 } });
  assert.equal(result.status, 'FAILED');
  assert.ok(result.attempts.length >= 2);
  assert.equal(a.calls.length, 0);
  assert.equal(b.calls.length, 1);
});

test('(l) error messages are length-capped and control chars stripped', async () => {
  const noisy = `bad\u0000\u0007 ${'x'.repeat(500)}`;
  const a = host('host-a', {
    async send() {
      throw beforeSendError(noisy);
    },
  });
  const router = createRouter({ hosts: [a] });
  const result = await router.route({ requestId: 'r-l1', request: { note: 'marker-xyz' } });
  assert.equal(result.status, 'FAILED');
  const msg = result.error?.message ?? '';
  assert.ok(msg.length <= 200);
  assert.equal(/[\u0000-\u001f]/.test(msg), false);
  assert.equal('request' in result, false);
  assert.ok(!JSON.stringify(result).includes('marker-xyz'));
});

test('synchronous throw from send is handled', async () => {
  const a = host('host-a', {
    send() {
      throw beforeSendError('sync');
    },
  });
  const b = host('host-b', { priority: 2, value: { ok: 1 } });
  // override async send with sync-throwing function
  a.send = () => {
    a.calls.push({});
    throw beforeSendError('sync');
  };
  const router = createRouter({ hosts: [a, b] });
  const result = await router.route({ requestId: 'r-sync', request: { n: 1 } });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.host, 'host-b');
});

test('abort before send is treated as before_send and may fall back', async () => {
  const a = host('host-a', {
    priority: 1,
    async send(_req, ctx) {
      if (ctx?.signal?.aborted) {
        const err = new Error('aborted');
        err.phase = 'before_send';
        throw err;
      }
      return { ok: true };
    },
  });
  const b = host('host-b', { priority: 2, value: { ok: true } });
  const router = createRouter({ hosts: [a, b] });
  const ac = new AbortController();
  ac.abort();
  const result = await router.route({
    requestId: 'r-abort1',
    request: { n: 1 },
    signal: ac.signal,
  });
  // Router itself should treat pre-send abort as before_send without calling send,
  // or adapters may surface before_send — either way fallback is allowed only pre-send.
  assert.ok(result.status === 'SUCCEEDED' || result.status === 'FAILED');
  if (result.status === 'SUCCEEDED') {
    assert.equal(result.host, 'host-b');
  }
});

test('(m) property: after a send that ends after_send/unknown, no later host is called', async () => {
  const phases = [undefined, null, 'before_send', 'after_send', 'other', ''];
  for (let trial = 0; trial < 2000; trial++) {
    const n = 1 + (trial % 5);
    const hosts = [];
    let unknownAt = -1;
    for (let i = 0; i < n; i++) {
      const id = `host-${String.fromCharCode(97 + i)}`;
      const phase = phases[(trial + i) % phases.length];
      const fail = (trial + i) % 3 !== 0; // mix success/fail
      hosts.push(
        host(id, {
          priority: i,
          async send() {
            if (!fail) return { ok: id };
            if (phase === 'before_send') throw beforeSendError(`${id}`);
            const err = new Error(`${id}`);
            if (phase !== undefined && phase !== null && phase !== '') err.phase = phase;
            throw err;
          },
        }),
      );
    }
    const router = createRouter({ hosts });
    const result = await router.route({
      requestId: `fuzz-${trial}`,
      request: { trial },
    });
    // Find first host whose call ended in non-before_send failure or success after send start
    let sendStartedIndex = -1;
    for (let i = 0; i < hosts.length; i++) {
      if (hosts[i].calls.length > 0) {
        // A call was made — if result is UNKNOWN or SUCCEEDED from this host, later must be 0
        sendStartedIndex = i;
        // Check if this attempt was before_send-only failure: then later hosts may run
        const attempt = result.attempts?.find((x) => x.host === hosts[i].id);
        if (attempt && attempt.outcome === 'error' && attempt.phase === 'before_send') {
          continue;
        }
        // send started and did not fail before_send → no later sends
        for (let j = i + 1; j < hosts.length; j++) {
          assert.equal(
            hosts[j].calls.length,
            0,
            `trial ${trial}: host ${hosts[j].id} called after send-start on ${hosts[i].id} status=${result.status}`,
          );
        }
        break;
      }
    }
    if (result.status === 'UNKNOWN' || result.status === 'SUCCEEDED') {
      const called = hosts.filter((h) => h.calls.length > 0);
      assert.ok(called.length >= 1);
      // last called host should be the terminal one; none after it
      const last = hosts.findIndex((h) => h.id === called[called.length - 1].id);
      for (let j = last + 1; j < hosts.length; j++) {
        assert.equal(hosts[j].calls.length, 0);
      }
    }
  }
});
