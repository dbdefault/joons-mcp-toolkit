#!/usr/bin/env node
// Child helper for multi-process lock tests.
// Args: <dir> <mode> [lockTimeoutMs] [staleMs]
import { Ledger, LedgerLockedError } from '../../src/ledger.mjs';

const [dir, mode, timeoutStr, staleStr] = process.argv.slice(2);

// When the test runner executes this file with no args, exit cleanly.
if (!dir || !mode) {
  process.exit(0);
}

const lockTimeoutMs = Number(timeoutStr || 0);
const staleMs = staleStr !== undefined && staleStr !== '' ? Number(staleStr) : 15_000;

try {
  if (mode === 'hold') {
    const ledger = await Ledger.open(dir, { fsync: true, lockTimeoutMs: 0, staleMs });
    process.stdout.write(JSON.stringify({ ok: true, pid: process.pid }) + '\n');
    await new Promise(() => {}); // hold until killed
    await ledger.close();
  } else if (mode === 'try') {
    try {
      const ledger = await Ledger.open(dir, { fsync: true, lockTimeoutMs, staleMs });
      process.stdout.write(JSON.stringify({ ok: true, pid: process.pid }) + '\n');
      await ledger.close();
      process.exit(0);
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, name: e.name, message: e.message }) + '\n');
      process.exit(e instanceof LedgerLockedError ? 2 : 1);
    }
  } else if (mode === 'steal') {
    // Compete to open a (possibly stale) lock; winner holds until killed.
    const watchdog = setTimeout(() => {
      process.stdout.write(JSON.stringify({ ok: false, name: 'Timeout', message: 'steal watchdog' }) + '\n');
      process.exit(3);
    }, 5000);
    try {
      const ledger = await Ledger.open(dir, { fsync: true, lockTimeoutMs, staleMs });
      clearTimeout(watchdog);
      process.stdout.write(JSON.stringify({ ok: true, pid: process.pid }) + '\n');
      await new Promise(() => {});
      await ledger.close();
    } catch (e) {
      clearTimeout(watchdog);
      process.stdout.write(JSON.stringify({ ok: false, name: e.name, message: e.message }) + '\n');
      process.exit(e instanceof LedgerLockedError ? 2 : 1);
    }
  } else {
    process.stderr.write('unknown mode\n');
    process.exit(1);
  }
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, name: e?.name, message: e?.message }) + '\n');
  process.exit(1);
}
