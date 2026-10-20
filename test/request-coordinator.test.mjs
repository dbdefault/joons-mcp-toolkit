import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestCoordinator, RequestConflictError, UnknownOutcomeError } from '../src/request-coordinator.mjs';

test('same ID and payload share one in-flight execution', async () => {
  const c = new RequestCoordinator();
  let count = 0;
  const exec = async () => { count++; await new Promise(r => setTimeout(r, 5)); return { ok: true }; };
  const result = await Promise.all([c.run('a', { x: 1 }, exec), c.run('a', { x: 1 }, exec)]);
  assert.equal(count, 1);
  assert.deepEqual(result[0], result[1]);
});
test('different payload with same ID is rejected', async () => {
  const c = new RequestCoordinator();
  await c.run('a', { x: 1 }, async () => ({ ok: true }));
  await assert.rejects(c.run('a', { x: 2 }, async () => ({ ok: true })), RequestConflictError);
});
test('missing receipt cannot become success', async () => {
  const c = new RequestCoordinator();
  await assert.rejects(c.run('a', {}, async () => undefined), /Missing execution receipt/);
  assert.equal(c.get('a').state, 'FAILED');
});
test('ambiguous outcome does not auto-retry', async () => {
  const c = new RequestCoordinator();
  let count = 0;
  const exec = async () => { count++; const e = new Error('Transport lost'); e.outcomeUnknown = true; throw e; };
  await assert.rejects(c.run('a', {}, exec));
  await assert.rejects(c.run('a', {}, exec), UnknownOutcomeError);
  assert.equal(count, 1);
  c.reconcile('a', { confirmed: true });
  assert.deepEqual(await c.run('a', {}, exec), { confirmed: true });
});
