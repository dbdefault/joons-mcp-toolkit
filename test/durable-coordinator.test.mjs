import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Ledger } from '../src/ledger.mjs';
import {
  RequestCoordinator,
  RequestConflictError,
  UnknownOutcomeError,
} from '../src/request-coordinator.mjs';

const tmp = async () => fs.mkdtemp(path.join(os.tmpdir(), 'dur-coord-'));

test('memory coordinator without ledger still matches 0.1.0 behavior', async () => {
  const c = new RequestCoordinator();
  let count = 0;
  const exec = async () => { count++; return { ok: true }; };
  await Promise.all([c.run('a', { x: 1 }, exec), c.run('a', { x: 1 }, exec)]);
  assert.equal(count, 1);
});

test('durable: succeed persists; restart returns result without execute', async () => {
  const dir = await tmp();
  const ledger = await Ledger.open(dir);
  const c = new RequestCoordinator({ ledger });
  let count = 0;
  const result = await c.run('job', { p: 1 }, async () => { count++; return { done: true }; });
  assert.deepEqual(result, { done: true });
  assert.equal(count, 1);
  await ledger.close();

  const ledger2 = await Ledger.open(dir);
  const c2 = new RequestCoordinator({ ledger: ledger2 });
  let count2 = 0;
  const again = await c2.run('job', { p: 1 }, async () => { count2++; return { nope: true }; });
  assert.deepEqual(again, { done: true });
  assert.equal(count2, 0);
  await ledger2.close();
});

test('durable: UNKNOWN and FAILED replay; conflict; same-id concurrent execute once', async () => {
  const dir = await tmp();
  const ledger = await Ledger.open(dir);
  const c = new RequestCoordinator({ ledger });
  await assert.rejects(
    c.run('u', {}, async () => { const e = new Error('lost'); e.outcomeUnknown = true; throw e; }),
  );
  await assert.rejects(c.run('u', {}, async () => ({ x: 1 })), UnknownOutcomeError);
  c.reconcile('u', { fixed: true });
  assert.deepEqual(await c.run('u', {}, async () => ({ x: 1 })), { fixed: true });

  await assert.rejects(
    c.run('f', {}, async () => { const e = new Error('nope'); e.code = 'EFAIL'; throw e; }),
  );
  await assert.rejects(c.run('f', {}, async () => ({})), (err) => {
    assert.equal(err.message, 'nope');
    assert.equal(err.code, 'EFAIL');
    return true;
  });

  await c.run('ok', { a: 1 }, async () => ({ ok: true }));
  await assert.rejects(c.run('ok', { a: 2 }, async () => ({ ok: true })), RequestConflictError);

  let n = 0;
  const exec = async () => { n++; await new Promise((r) => setTimeout(r, 20)); return { n }; };
  const parts = await Promise.all(Array.from({ length: 50 }, () => c.run('many', { k: 1 }, exec)));
  assert.equal(n, 1);
  assert.ok(parts.every((p) => p.n === 1));
  await ledger.close();
});

test('durable: crash while RUNNING then open yields UNKNOWN', async () => {
  const dir = await tmp();
  const ledger = await Ledger.open(dir);
  const c = new RequestCoordinator({ ledger });
  const pending = c.run('mid', { z: 1 }, async () => {
    await new Promise((r) => setTimeout(r, 60_000));
    return { late: true };
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.get('mid').state, 'RUNNING');
  // simulate process loss: close without finishing (do not await pending)
  await ledger.close();
  void pending.catch(() => {});

  const ledger2 = await Ledger.open(dir);
  assert.equal(ledger2.get('mid').state, 'UNKNOWN');
  const c2 = new RequestCoordinator({ ledger: ledger2 });
  await assert.rejects(c2.run('mid', { z: 1 }, async () => ({ x: 1 })), UnknownOutcomeError);
  await ledger2.close();
});
