#!/usr/bin/env node
// Child helper for multi-process lock tests. Args: <dir> <mode> [lockTimeoutMs]
import { Ledger, LedgerLockedError } from '../../src/ledger.mjs';

const [dir, mode, timeoutStr] = process.argv.slice(2);

// When the test runner executes this file with no args, exit cleanly.
if (!dir || !mode) {
  process.exit(0);
}

const lockTimeoutMs = Number(timeoutStr || 0);

try {
  if (mode === 'hold') {
    const ledger = await Ledger.open(dir, { fsync: true, lockTimeoutMs: 0 });
    process.stdout.write(JSON.stringify({ ok: true, pid: process.pid }) + '\n');
    await new Promise(() => {}); // hold until killed
    await ledger.close();
  } else if (mode === 'try') {
    try {
      const ledger = await Ledger.open(dir, { fsync: true, lockTimeoutMs });
      process.stdout.write(JSON.stringify({ ok: true, pid: process.pid }) + '\n');
      await ledger.close();
      process.exit(0);
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, name: e.name, message: e.message }) + '\n');
      process.exit(e instanceof LedgerLockedError ? 2 : 1);
    }
  } else if (mode === 'probe') {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const lockPath = path.join(dir, 'ledger.lock');
    const exists = fs.existsSync(lockPath);
    let raw = null;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch {
      raw = null;
    }
    process.stdout.write(JSON.stringify({ exists, raw, pid: process.pid }) + '\n');
    process.exit(0);
  } else {
    process.stderr.write('unknown mode\n');
    process.exit(1);
  }
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, name: e?.name, message: e?.message }) + '\n');
  process.exit(1);
}
