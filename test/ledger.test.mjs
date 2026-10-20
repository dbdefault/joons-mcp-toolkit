import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  Ledger,
  LedgerStateError,
  LedgerLimitError,
} from '../src/ledger.mjs';
import { RequestConflictError } from '../src/request-coordinator.mjs';

const tmp = async () => fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));

test('idempotent accept and conflict fingerprint', async () => {
  const dir = await tmp();
  const L = await Ledger.open(dir);
  const a = await L.accept('r1', { n: 1 });
  assert.equal(a.created, true);
  assert.equal(a.record.state, 'ACCEPTED');
  const b = await L.accept('r1', { n: 1 });
  assert.equal(b.created, false);
  assert.equal(b.record.id, 'r1');
  await assert.rejects(() => L.accept('r1', { n: 2 }), RequestConflictError);
  await assert.rejects(() => L.accept('', {}), TypeError);
  await assert.rejects(() => L.accept(null, {}), TypeError);
  await L.close();
});

test('transition rules exhaustive', async () => {
  const dir = await tmp();
  const L = await Ledger.open(dir);
  await L.accept('t1', { x: 1 });
  await L.markRunning('t1');
  await L.succeed('t1', { ok: true });
  await assert.rejects(() => L.markRunning('t1'), LedgerStateError);
  await assert.rejects(() => L.fail('t1', new Error('x')), LedgerStateError);
  await assert.rejects(() => L.succeed('t1', { again: true }), LedgerStateError);

  await L.accept('t2', {});
  await L.markRunning('t2');
  await L.fail('t2', Object.assign(new Error('boom'), { code: 'E' }));
  await assert.rejects(() => L.reconcile('t2', { x: 1 }), LedgerStateError);

  await L.accept('t3', {});
  await L.markRunning('t3');
  await L.markUnknown('t3', 'lost');
  await assert.rejects(() => L.fail('t3', new Error('no')), LedgerStateError);
  await L.reconcile('t3', { confirmed: true });
  assert.equal(L.get('t3').state, 'SUCCEEDED');
  await L.close();
});

test('result undefined and size limit', async () => {
  const dir = await tmp();
  const L = await Ledger.open(dir);
  await L.accept('u1', {});
  await L.markRunning('u1');
  await assert.rejects(() => L.succeed('u1', undefined), /receipt|undefined|required/i);
  const big = 'x'.repeat(65 * 1024);
  await assert.rejects(() => L.succeed('u1', { big }), LedgerLimitError);
  await L.close();
});

test('write failure leaves memory unchanged', async () => {
  const dir = await tmp();
  let failNext = false;
  const real = await import('node:fs/promises');
  const deps = {
    fs: {
      ...real,
      open: async (p, flags) => {
        const handle = await real.open(p, flags);
        if (String(p).endsWith('ledger.jsonl') && String(flags).includes('a')) {
          return {
            writeFile: async (data) => {
              if (failNext) throw new Error('injected write failure');
              return handle.writeFile(data);
            },
            sync: async () => handle.sync(),
            close: async () => handle.close(),
          };
        }
        return handle;
      },
    },
  };
  const L = await Ledger.open(dir, { fsync: true, deps });
  await L.accept('w1', { a: 1 });
  failNext = true;
  const before = L.get('w1');
  await assert.rejects(() => L.markRunning('w1'), /injected write failure/);
  assert.deepEqual(L.get('w1'), before);
  assert.equal(L.get('w1').state, 'ACCEPTED');
  failNext = false;
  await L.markRunning('w1');
  assert.equal(L.get('w1').state, 'RUNNING');
  await L.close();
});

test('seq continuous under concurrent accepts', async () => {
  const dir = await tmp();
  const L = await Ledger.open(dir);
  await Promise.all(Array.from({ length: 100 }, (_, i) => L.accept(`id-${i}`, { i })));
  const listed = L.list({});
  assert.equal(listed.length, 100);
  const text = await fs.readFile(path.join(dir, 'ledger.jsonl'), 'utf8');
  const seqs = text.trim().split('\n').map((l) => JSON.parse(l).seq);
  assert.deepEqual(seqs, Array.from({ length: 100 }, (_, i) => i + 1));
  await L.close();
});

test('compact preserves logical state', async () => {
  const dir = await tmp();
  const L = await Ledger.open(dir);
  await L.accept('c1', { v: 1 });
  await L.markRunning('c1');
  await L.succeed('c1', { done: true });
  await L.accept('c2', { v: 2 });
  await L.compact();
  assert.equal(L.get('c1').state, 'SUCCEEDED');
  assert.equal(L.get('c2').state, 'ACCEPTED');
  await L.close();
  const L2 = await Ledger.open(dir);
  assert.equal(L2.get('c1').state, 'SUCCEEDED');
  assert.deepEqual(L2.get('c1').result, { done: true });
  assert.equal(L2.get('c2').state, 'ACCEPTED');
  await L2.close();
});

test('builtin imports only (node:); ledger has no net or child_process', async () => {
  const src = await fs.readFile(new URL('../src/ledger.mjs', import.meta.url), 'utf8');
  const coord = await fs.readFile(new URL('../src/request-coordinator.mjs', import.meta.url), 'utf8');
  for (const text of [src, coord]) {
    const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'), spec);
      if (!spec.startsWith('node:') && !spec.startsWith('.')) assert.fail(`external import: ${spec}`);
    }
    assert.equal(imports.some((s) => s.startsWith('node:') === false && !s.startsWith('.')), false);
  }
  assert.equal(/\bfrom\s+['"](?!\.|node:)[^'"]+['"]/.test(src), false);
  assert.equal(/\bfrom\s+['"](?!\.|node:)[^'"]+['"]/.test(coord), false);
  assert.equal(/node:net\b/.test(src), false);
  assert.equal(/node:child_process\b/.test(src), false);
  assert.equal(/\bfrom\s+['"]node:net['"]/.test(src), false);
  assert.equal(/\bfrom\s+['"]node:child_process['"]/.test(src), false);
});
