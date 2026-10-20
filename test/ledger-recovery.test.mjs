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

function spawnChild(args) {
  return spawn(process.execPath, [childPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function readFirstLine(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('child timeout')), timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) {
        clearTimeout(timer);
        resolve(buf.split('\n')[0]);
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function readExit(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      reject(new Error(`child exit timeout buf=${buf} code=${child.exitCode}`));
    }, timeoutMs);
    const finish = (code) => {
      clearTimeout(timer);
      resolve({ buf: buf.trim(), code });
    };
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    if (child.exitCode !== null) {
      finish(child.exitCode);
      return;
    }
    child.on('exit', finish);
  });
}

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

test('two real processes: only one open succeeds', async () => {
  const dir = await tmp();
  // Large staleMs so heartbeat (staleMs/2) tolerates load jitter.
  const staleMs = 2000;
  const holder = spawnChild([dir, 'hold', '0', String(staleMs)]);
  const firstLine = await readFirstLine(holder, 8000);
  assert.equal(JSON.parse(firstLine).ok, true);

  const challenged = await new Promise((resolve, reject) => {
    const challenger = spawnChild([dir, 'try', '0', String(staleMs)]);
    let buf = '';
    const timer = setTimeout(() => {
      try { challenger.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`challenger hang buf=${buf}`));
    }, 8000);
    challenger.stdout.on('data', (d) => { buf += d; });
    challenger.stderr.on('data', (d) => { buf += d; });
    challenger.on('exit', (code) => {
      clearTimeout(timer);
      try {
        resolve({ ...JSON.parse(buf.trim().split('\n')[0]), code });
      } catch (e) {
        reject(new Error(`bad challenger output: ${buf} code=${code}`));
      }
    });
  });
  assert.equal(challenged.ok, false);
  assert.equal(challenged.name, 'LedgerLockedError');
  await assert.rejects(() => Ledger.open(dir, { staleMs, lockTimeoutMs: 0 }), LedgerLockedError);

  let holderExited = holder.exitCode !== null;
  holder.on('exit', () => { holderExited = true; });
  try {
    holder.kill('SIGKILL');
  } catch {
    try { holder.kill(); } catch { /* ignore */ }
  }
  for (let i = 0; i < 50 && !holderExited && holder.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(holderExited || holder.exitCode !== null, 'holder should exit after SIGKILL');
});

test('dead owner lock is taken over via ESRCH without waiting 4x staleMs', async () => {
  const dir = await tmp();
  const staleMs = 300;
  const holder = spawnChild([dir, 'hold', '0', String(staleMs)]);
  const firstLine = await readFirstLine(holder, 8000);
  assert.equal(JSON.parse(firstLine).ok, true);

  let holderExited = holder.exitCode !== null;
  holder.on('exit', () => { holderExited = true; });
  try {
    holder.kill('SIGKILL');
  } catch {
    try { holder.kill(); } catch { /* ignore */ }
  }
  for (let i = 0; i < 50 && !holderExited && holder.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(holderExited || holder.exitCode !== null, 'holder should exit after SIGKILL');
  // ESRCH reclaim requires age > staleMs/2 (missed heartbeat); still far below 4×staleMs.
  await new Promise((r) => setTimeout(r, staleMs / 2 + 100));

  const L = await Ledger.open(dir, { staleMs });
  assert.ok(L);
  await L.close();
});

test('live pid: mtime between staleMs and 4x is locked; beyond 4x is reclaimable', async () => {
  const dir = await tmp();
  const staleMs = 200;
  const lockDir = path.join(dir, 'ledger.lock');
  await fs.mkdir(lockDir);
  // Use this process pid so the owner is definitely alive.
  await fs.writeFile(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.pid, token: 'livetoken', startedAt: new Date().toISOString() }),
  );

  const mid = new Date(Date.now() - staleMs * 3);
  await fs.utimes(lockDir, mid, mid);
  await assert.rejects(() => Ledger.open(dir, { staleMs, lockTimeoutMs: 0 }), LedgerLockedError);

  const old = new Date(Date.now() - staleMs * 5);
  await fs.utimes(lockDir, old, old);
  const L = await Ledger.open(dir, { staleMs });
  assert.ok(L);
  await L.close();
});

test('heartbeat keeps lock; external remove compromises writer', async () => {
  const dir = await tmp();
  const staleMs = 400;
  const L = await Ledger.open(dir, { staleMs });
  await L.accept('a', { n: 1 });

  // Live owner longer than staleMs but under 4×staleMs; another open must fail.
  await new Promise((r) => setTimeout(r, staleMs + 200));
  await assert.rejects(() => Ledger.open(dir, { staleMs, lockTimeoutMs: 0 }), LedgerLockedError);

  // External delete of lock dir → subsequent writes rejected.
  await fs.rm(path.join(dir, 'ledger.lock'), { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, Math.floor(staleMs / 2) + 50));
  await assert.rejects(() => L.accept('b', { n: 2 }), (err) => {
    assert.equal(err.name, 'LedgerLockedError');
    assert.match(String(err.message), /lock lost/i);
    return true;
  });
  await L.close();
});

test('exactly one of six processes wins a stale lock reclaim', async () => {
  const dir = await tmp();
  const staleMs = 300;
  // Create a stale lock directory with a dead pid and old mtime.
  const lockDir = path.join(dir, 'ledger.lock');
  await fs.mkdir(lockDir);
  await fs.writeFile(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: 1_000_000_007, token: 'deadtoken', startedAt: new Date(0).toISOString() }),
  );
  const old = new Date(Date.now() - staleMs * 3);
  await fs.utimes(lockDir, old, old);

  const kids = Array.from({ length: 6 }, () => spawnChild([dir, 'steal', '0', String(staleMs)]));
  const results = await Promise.all(kids.map(async (k) => {
    try {
      const line = await readFirstLine(k, 8000);
      return JSON.parse(line);
    } catch {
      return { ok: false };
    }
  }));
  const wins = results.filter((r) => r.ok === true);
  assert.equal(wins.length, 1, JSON.stringify(results));
  for (const k of kids) {
    try {
      k.kill('SIGKILL');
    } catch {
      try { k.kill(); } catch { /* ignore */ }
    }
  }
  for (let i = 0; i < 50; i++) {
    if (kids.every((k) => k.exitCode !== null)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('stale rename race: challenger must not delete winner lock', async () => {
  const dir = await tmp();
  const staleMs = 200;
  const lockDir = path.join(dir, 'ledger.lock');
  await fs.mkdir(lockDir);
  const staleOwner = {
    pid: 1_000_000_007,
    token: 'stale-original',
    startedAt: new Date(0).toISOString(),
  };
  await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify(staleOwner));
  const old = new Date(Date.now() - staleMs * 5);
  await fs.utimes(lockDir, old, old);

  let winner = null;
  const loser = Ledger.open(dir, {
    staleMs,
    lockTimeoutMs: 0,
    deps: {
      beforeStaleRename: async () => {
        // A wins first: reclaim and install a fresh lock before B renames.
        winner = await Ledger.open(dir, { staleMs, lockTimeoutMs: 0 });
      },
    },
  });

  await assert.rejects(() => loser, LedgerLockedError);
  assert.ok(winner);
  const owner = JSON.parse(await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8'));
  assert.notEqual(owner.token, 'stale-original');
  assert.equal(owner.pid, process.pid);
  await winner.close();
});
