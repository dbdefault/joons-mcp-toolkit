import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  Ledger,
  LedgerCorruptError,
  LedgerLockedError,
} from '../src/ledger.mjs';

const tmp = async () => fs.mkdtemp(path.join(os.tmpdir(), 'ledger-rec-'));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const childPath = path.join(__dirname, 'helpers', 'ledger-child.mjs');

test('restart: SUCCEEDED not re-executed; RUNNING becomes UNKNOWN', async () => {
  const dir = await tmp();
  const L = await Ledger.open(dir);
  await L.accept('ok', { a: 1 });
  await L.markRunning('ok');
  await L.succeed('ok', { value: 7 });
  await L.accept('run', { b: 2 });
  await L.markRunning('run');
  await L.close();

  const L2 = await Ledger.open(dir);
  assert.equal(L2.get('ok').state, 'SUCCEEDED');
  assert.deepEqual(L2.get('ok').result, { value: 7 });
  assert.equal(L2.get('run').state, 'UNKNOWN');
  assert.ok(L2.get('run').reason);
  await L2.close();
});

test('partial last line recovered by truncate; middle corruption rejected', async () => {
  const dir = await tmp();
  const L = await Ledger.open(dir);
  await L.accept('a', { n: 1 });
  await L.accept('b', { n: 2 });
  await L.close();
  const file = path.join(dir, 'ledger.jsonl');
  const good = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, good + '{"v":1,"seq":3,partial');
  const L2 = await Ledger.open(dir);
  assert.ok(L2.recovery?.truncatedBytes > 0);
  assert.equal(L2.get('a').state, 'ACCEPTED');
  assert.equal(L2.get('b').state, 'ACCEPTED');
  await L2.close();

  const lines = good.trim().split('\n');
  const brokenMiddle = [lines[0], '{not-json', lines[1]].join('\n') + '\n';
  await fs.writeFile(file, brokenMiddle);
  await assert.rejects(() => Ledger.open(dir), LedgerCorruptError);
});

test('crc tamper and seq gap detected', async () => {
  const dir = await tmp();
  const L = await Ledger.open(dir);
  await L.accept('x', { z: 1 });
  await L.close();
  const file = path.join(dir, 'ledger.jsonl');
  const row = JSON.parse((await fs.readFile(file, 'utf8')).trim());
  row.crc = '0000000000000000';
  await fs.writeFile(file, JSON.stringify(row) + '\n');
  await assert.rejects(() => Ledger.open(dir), LedgerCorruptError);

  const dir2 = await tmp();
  const L3 = await Ledger.open(dir2);
  await L3.accept('y', {});
  await L3.close();
  const f2 = path.join(dir2, 'ledger.jsonl');
  const e = JSON.parse((await fs.readFile(f2, 'utf8')).trim());
  e.seq = 5;
  const { createHash } = await import('node:crypto');
  const { crc, ...rest } = e;
  e.crc = createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
  await fs.writeFile(f2, JSON.stringify(e) + '\n');
  await assert.rejects(() => Ledger.open(dir2), LedgerCorruptError);
});

test('two real processes: only one open succeeds; dead lock is taken over', async () => {
  const dir = await tmp();
  const holder = spawn(process.execPath, [childPath, dir, 'hold'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const firstLine = await new Promise((resolve, reject) => {
    let buf = '';
    holder.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) resolve(buf.split('\n')[0]);
    });
    holder.on('error', reject);
    setTimeout(() => reject(new Error('holder timeout')), 10000);
  });
  assert.equal(JSON.parse(firstLine).ok, true);

  const challenger = spawn(process.execPath, [childPath, dir, 'try', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = await new Promise((resolve) => {
    let buf = '';
    challenger.stdout.on('data', (d) => { buf += d; });
    challenger.on('exit', () => resolve(buf.trim()));
  });
  const challenged = JSON.parse(out);
  assert.equal(challenged.ok, false);
  assert.equal(challenged.name, 'LedgerLockedError');

  holder.kill('SIGTERM');
  await new Promise((r) => holder.on('exit', r));
  // allow OS to release
  await new Promise((r) => setTimeout(r, 100));

  const L = await Ledger.open(dir);
  assert.ok(L);
  await L.close();
});
