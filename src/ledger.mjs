import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { RequestConflictError } from './request-coordinator.mjs';

const MAX_LINE = 256 * 1024;
const MAX_BLOB = 64 * 1024;

export class LedgerStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerStateError';
  }
}
export class LedgerCorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerCorruptError';
  }
}
export class LedgerLockedError extends Error {
  constructor(message = 'Ledger is locked by another process') {
    super(message);
    this.name = 'LedgerLockedError';
  }
}
export class LedgerLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerLimitError';
  }
}

function fingerprint(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function eventCrc(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
}

/**
 * Best-effort liveness check.
 * On Windows, process.kill(pid, 0) can report ESRCH for a still-living
 * process; when that happens, confirm with Get-Process before reclaiming.
 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (!(e && e.code === 'ESRCH')) return true;
  }
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Get-Process -Id ${pid} | Out-Null`],
        { windowsHide: true, timeout: 5000 },
      );
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Stable ephemeral port in 49152–65535 derived from absolute dir path. */
function lockPortFor(dir) {
  const h = createHash('sha256').update(path.resolve(dir)).digest();
  return 49152 + (h.readUInt16BE(0) % (65535 - 49152 + 1));
}

function listenLocal(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

function cloneRecord(r) {
  if (!r) return null;
  const out = {
    id: r.id,
    state: r.state,
    fingerprint: r.fingerprint,
    seq: r.seq,
    updatedAt: r.updatedAt,
  };
  if (r.result !== undefined) out.result = structuredClone
    ? structuredClone(r.result)
    : JSON.parse(JSON.stringify(r.result));
  if (r.error) out.error = { ...r.error };
  if (r.reason !== undefined) out.reason = r.reason;
  return out;
}

function serializeBlob(value, label) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new LedgerLimitError(`${label} is not JSON-serializable`);
  }
  if (text === undefined) throw new TypeError(`${label} required`);
  if (Buffer.byteLength(text, 'utf8') > MAX_BLOB) {
    throw new LedgerLimitError(`${label} exceeds ${MAX_BLOB} bytes`);
  }
  return value;
}

function errorShape(error) {
  const out = {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'Error'),
  };
  if (error && error.code !== undefined) out.code = error.code;
  serializeBlob(out, 'error');
  return out;
}

/**
 * Append-only durable request ledger (local filesystem).
 * Single-host local disk recommended; network filesystems are not advised.
 */
export class Ledger {
  #dir;
  #file;
  #lockPath;
  #token;
  #fsync;
  #fs;
  #lockServer = null;
  #index = new Map();
  #seq = 0;
  #queue = Promise.resolve();
  #closed = false;
  recovery = null;

  constructor(dir, { fsync, token, fs, recovery, lockServer }) {
    this.#dir = dir;
    this.#file = path.join(dir, 'ledger.jsonl');
    this.#lockPath = path.join(dir, 'ledger.lock');
    this.#fsync = fsync;
    this.#token = token;
    this.#fs = fs;
    this.#lockServer = lockServer || null;
    this.recovery = recovery;
  }

  static async open(dir, { fsync = true, lockTimeoutMs = 0, deps = {} } = {}) {
    const fs = deps.fs || await import('node:fs/promises');
    await fs.mkdir(dir, { recursive: true });
    const { token, server } = await acquireLock(dir, lockTimeoutMs, fs);
    const ledger = new Ledger(dir, { fsync, token, fs, recovery: null, lockServer: server });
    try {
      await ledger.#replay();
      return ledger;
    } catch (e) {
      try {
        await ledger.close();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  get(id) {
    return cloneRecord(this.#index.get(id));
  }

  list({ state } = {}) {
    let rows = [...this.#index.values()];
    if (state) rows = rows.filter((r) => r.state === state);
    return rows.map(cloneRecord);
  }

  accept(id, payload) {
    return this.#enqueued(async () => {
      this.#ensureOpen();
      if (typeof id !== 'string' || !id.trim()) throw new TypeError('Non-empty request ID required');
      const fp = fingerprint(payload);
      const prior = this.#index.get(id);
      if (prior) {
        if (prior.fingerprint !== fp) throw new RequestConflictError(id);
        return { created: false, record: cloneRecord(prior) };
      }
      const record = await this.#appendAndApply({
        type: 'accept',
        id,
        fingerprint: fp,
      });
      return { created: true, record };
    });
  }

  markRunning(id) {
    return this.#enqueued(async () => {
      this.#ensureOpen();
      const cur = this.#require(id);
      if (cur.state !== 'ACCEPTED') throw new LedgerStateError(`Cannot markRunning from ${cur.state}`);
      return this.#appendAndApply({ type: 'running', id });
    });
  }

  succeed(id, result) {
    return this.#enqueued(async () => {
      this.#ensureOpen();
      if (result === undefined) throw new TypeError('Receipt required');
      const cur = this.#require(id);
      if (cur.state !== 'RUNNING') throw new LedgerStateError(`Cannot succeed from ${cur.state}`);
      const safe = serializeBlob(result, 'result');
      return this.#appendAndApply({ type: 'succeed', id, result: safe });
    });
  }

  fail(id, error) {
    return this.#enqueued(async () => {
      this.#ensureOpen();
      const cur = this.#require(id);
      if (cur.state !== 'RUNNING') throw new LedgerStateError(`Cannot fail from ${cur.state}`);
      return this.#appendAndApply({ type: 'fail', id, error: errorShape(error) });
    });
  }

  markUnknown(id, reason) {
    return this.#enqueued(async () => {
      this.#ensureOpen();
      const cur = this.#require(id);
      if (cur.state !== 'RUNNING') throw new LedgerStateError(`Cannot markUnknown from ${cur.state}`);
      return this.#appendAndApply({ type: 'unknown', id, reason: String(reason ?? 'unknown') });
    });
  }

  reconcile(id, result) {
    return this.#enqueued(async () => {
      this.#ensureOpen();
      if (result === undefined) throw new TypeError('Receipt required');
      const cur = this.#require(id);
      if (cur.state !== 'UNKNOWN') throw new LedgerStateError(`Cannot reconcile from ${cur.state}`);
      const safe = serializeBlob(result, 'result');
      return this.#appendAndApply({ type: 'reconcile', id, result: safe });
    });
  }

  async compact() {
    return this.#enqueued(async () => {
      this.#ensureOpen();
      const events = [];
      let seq = 0;
      for (const rec of this.#index.values()) {
        seq += 1;
        events.push(this.#buildEvent({ type: 'accept', id: rec.id, fingerprint: rec.fingerprint }, seq));
        if (rec.state === 'ACCEPTED') continue;
        seq += 1;
        events.push(this.#buildEvent({ type: 'running', id: rec.id }, seq));
        if (rec.state === 'RUNNING') continue;
        seq += 1;
        if (rec.state === 'SUCCEEDED') {
          events.push(this.#buildEvent({ type: 'succeed', id: rec.id, result: rec.result }, seq));
        } else if (rec.state === 'FAILED') {
          events.push(this.#buildEvent({ type: 'fail', id: rec.id, error: rec.error }, seq));
        } else if (rec.state === 'UNKNOWN') {
          events.push(this.#buildEvent({ type: 'unknown', id: rec.id, reason: rec.reason || 'unknown' }, seq));
        }
      }
      const body = events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
      const tmp = path.join(this.#dir, `ledger.${this.#token}.tmp`);
      const handle = await this.#fs.open(tmp, 'w');
      try {
        await handle.writeFile(body, 'utf8');
        if (this.#fsync) await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#fs.rename(tmp, this.#file);
      this.#seq = seq;
      return this.list({});
    });
  }

  async close() {
    if (this.#closed) return;
    // Drain queued writes before marking closed so in-flight appends finish.
    await this.#queue.catch(() => {});
    this.#closed = true;
    await closeServer(this.#lockServer);
    this.#lockServer = null;
    try {
      const raw = await this.#fs.readFile(this.#lockPath, 'utf8');
      const holder = JSON.parse(raw);
      if (holder.token === this.#token) await this.#fs.unlink(this.#lockPath);
    } catch {
      /* ignore */
    }
  }

  #ensureOpen() {
    if (this.#closed) throw new Error('Ledger is closed');
  }

  #require(id) {
    const cur = this.#index.get(id);
    if (!cur) throw new LedgerStateError(`Unknown request id: ${id}`);
    return cur;
  }

  #enqueued(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(() => {}, () => {});
    return run;
  }

  #buildEvent(fields, seq = this.#seq + 1) {
    const body = {
      v: 1,
      seq,
      ts: new Date().toISOString(),
      ...fields,
    };
    const crc = eventCrc(body);
    const event = { ...body, crc };
    const line = JSON.stringify(event);
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE) {
      throw new LedgerLimitError(`event line exceeds ${MAX_LINE} bytes`);
    }
    return event;
  }

  async #appendAndApply(fields) {
    const event = this.#buildEvent(fields);
    await this.#writeLine(event);
    this.#seq = event.seq;
    this.#apply(event);
    return cloneRecord(this.#index.get(event.id));
  }

  async #writeLine(event) {
    const line = JSON.stringify(event) + '\n';
    const handle = await this.#fs.open(this.#file, 'a');
    try {
      await handle.writeFile(line, 'utf8');
      if (this.#fsync) await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #apply(event) {
    const now = event.ts;
    if (event.type === 'accept') {
      this.#index.set(event.id, {
        id: event.id,
        state: 'ACCEPTED',
        fingerprint: event.fingerprint,
        seq: event.seq,
        updatedAt: now,
      });
      return;
    }
    const cur = this.#index.get(event.id);
    if (!cur) throw new LedgerCorruptError(`event for missing id ${event.id}`);
    if (event.type === 'running') {
      cur.state = 'RUNNING';
    } else if (event.type === 'succeed' || event.type === 'reconcile') {
      cur.state = 'SUCCEEDED';
      cur.result = event.result;
      delete cur.error;
      delete cur.reason;
    } else if (event.type === 'fail') {
      cur.state = 'FAILED';
      cur.error = event.error;
      delete cur.result;
      delete cur.reason;
    } else if (event.type === 'unknown' || event.type === 'recovered') {
      cur.state = 'UNKNOWN';
      cur.reason = event.reason || 'recovered';
      delete cur.result;
    } else {
      throw new LedgerCorruptError(`unknown event type ${event.type}`);
    }
    cur.seq = event.seq;
    cur.updatedAt = now;
  }

  async #replay() {
    let text = '';
    try {
      text = await this.#fs.readFile(this.#file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        this.#seq = 0;
        return;
      }
      throw e;
    }
    if (!text) {
      this.#seq = 0;
      return;
    }
    const rawLines = text.split('\n');
    const lines = [];
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (i === rawLines.length - 1 && line === '') continue;
      lines.push(line);
    }

    let expected = 1;
    let goodEnd = 0;
    let consumed = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      let event;
      let parsed = false;
      try {
        event = JSON.parse(line);
        parsed = true;
      } catch (e) {
        // Incomplete trailing write only: truncate. Middle parse failure is corruption.
        if (isLast) {
          this.recovery = { truncatedBytes: text.length - goodEnd };
          await this.#fs.truncate(this.#file, goodEnd);
          break;
        }
        throw new LedgerCorruptError(`corrupt ledger at line ${i + 1}: ${e.message}`);
      }
      try {
        if (!event || typeof event !== 'object') throw new Error('not object');
        const { crc, ...rest } = event;
        if (crc !== eventCrc(rest)) throw new Error('bad crc');
        if (event.seq !== expected) throw new Error(`seq gap want ${expected} got ${event.seq}`);
      } catch (e) {
        // Valid JSON with bad crc/seq is always corruption (even if last line).
        throw new LedgerCorruptError(`corrupt ledger at line ${i + 1}: ${e.message}`);
      }
      if (!parsed) continue;
      this.#apply(event);
      this.#seq = event.seq;
      expected += 1;
      consumed += Buffer.byteLength(line, 'utf8') + 1;
      goodEnd = consumed;
    }

    const running = [...this.#index.values()].filter((r) => r.state === 'RUNNING');
    for (const rec of running) {
      await this.#appendAndApply({ type: 'recovered', id: rec.id, reason: 'interrupted' });
    }
  }
}

async function acquireLock(dir, lockTimeoutMs, fs) {
  const lockPath = path.join(dir, 'ledger.lock');
  const port = lockPortFor(dir);
  const token = randomBytes(16).toString('hex');
  const started = Date.now();
  let reclaimAttempted = false;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      let server = null;
      try {
        server = await listenLocal(port);
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            token,
            startedAt: new Date().toISOString(),
            port,
          }),
          'utf8',
        );
        if (typeof handle.sync === 'function') {
          try {
            await handle.sync();
          } catch {
            /* sync optional on some fs mocks */
          }
        }
      } catch (inner) {
        await handle.close().catch(() => {});
        await closeServer(server);
        try {
          await fs.unlink(lockPath);
        } catch {
          /* ignore */
        }
        throw inner;
      }
      await handle.close();
      return { token, server };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      // Prefer TCP probe: if the lock port is bound, the holder is alive.
      let probe = null;
      try {
        probe = await listenLocal(port);
        await closeServer(probe);
        probe = null;
        // Port free → treat lock file as stale (pid check is unreliable on Windows).
      } catch (le) {
        if (le && le.code === 'EADDRINUSE') {
          if (!lockTimeoutMs || lockTimeoutMs <= 0) throw new LedgerLockedError();
          if (Date.now() - started >= lockTimeoutMs) throw new LedgerLockedError();
          await sleep(50);
          continue;
        }
        // Probe failed for another reason: fall back to pid liveness.
        let holder = null;
        try {
          holder = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        } catch {
          holder = null;
        }
        if (holder && alive(holder.pid)) {
          if (!lockTimeoutMs || lockTimeoutMs <= 0) throw new LedgerLockedError();
          if (Date.now() - started >= lockTimeoutMs) throw new LedgerLockedError();
          await sleep(50);
          continue;
        }
      }

      if (!reclaimAttempted) {
        reclaimAttempted = true;
        try {
          await fs.unlink(lockPath);
        } catch {
          /* ignore */
        }
        continue;
      }
      if (!lockTimeoutMs || lockTimeoutMs <= 0) throw new LedgerLockedError();
      if (Date.now() - started >= lockTimeoutMs) throw new LedgerLockedError();
      await sleep(50);
    }
  }
}
