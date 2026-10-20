import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { RequestConflictError } from './request-coordinator.mjs';

const MAX_LINE = 256 * 1024;
const MAX_BLOB = 64 * 1024;
const DEFAULT_STALE_MS = 15_000;

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** True only when process.kill(pid, 0) reports ESRCH (process is gone). */
function pidDefinitelyDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return !!(e && e.code === 'ESRCH');
  }
}

/** Live (or EPERM) owners are stale only after this multiple of staleMs. */
const STALE_LIVE_MULTIPLIER = 4;

function cloneRecord(r) {
  if (!r) return null;
  const out = {
    id: r.id,
    state: r.state,
    fingerprint: r.fingerprint,
    seq: r.seq,
    updatedAt: r.updatedAt,
  };
  if (r.result !== undefined) {
    out.result = structuredClone
      ? structuredClone(r.result)
      : JSON.parse(JSON.stringify(r.result));
  }
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
  #lockDir;
  #token;
  #fsync;
  #fs;
  #staleMs;
  #heartbeat = null;
  #compromised = false;
  #index = new Map();
  #seq = 0;
  #queue = Promise.resolve();
  #closed = false;
  recovery = null;

  constructor(dir, { fsync, token, fs, recovery, staleMs }) {
    this.#dir = dir;
    this.#file = path.join(dir, 'ledger.jsonl');
    this.#lockDir = path.join(dir, 'ledger.lock');
    this.#fsync = fsync;
    this.#token = token;
    this.#fs = fs;
    this.#staleMs = staleMs;
    this.recovery = recovery;
  }

  static async open(dir, {
    fsync = true,
    lockTimeoutMs = 0,
    staleMs = DEFAULT_STALE_MS,
    deps = {},
  } = {}) {
    const fs = deps.fs || await import('node:fs/promises');
    await fs.mkdir(dir, { recursive: true });
    const token = await acquireLock(dir, {
      lockTimeoutMs,
      staleMs,
      beforeStaleRename: deps.beforeStaleRename,
    }, fs);
    const ledger = new Ledger(dir, { fsync, token, fs, recovery: null, staleMs });
    ledger.#startHeartbeat();
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
      this.#ensureWritable();
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
      this.#ensureWritable();
      const cur = this.#require(id);
      if (cur.state !== 'ACCEPTED') throw new LedgerStateError(`Cannot markRunning from ${cur.state}`);
      return this.#appendAndApply({ type: 'running', id });
    });
  }

  succeed(id, result) {
    return this.#enqueued(async () => {
      this.#ensureWritable();
      if (result === undefined) throw new TypeError('Receipt required');
      const cur = this.#require(id);
      if (cur.state !== 'RUNNING') throw new LedgerStateError(`Cannot succeed from ${cur.state}`);
      const safe = serializeBlob(result, 'result');
      return this.#appendAndApply({ type: 'succeed', id, result: safe });
    });
  }

  fail(id, error) {
    return this.#enqueued(async () => {
      this.#ensureWritable();
      const cur = this.#require(id);
      if (cur.state !== 'RUNNING') throw new LedgerStateError(`Cannot fail from ${cur.state}`);
      return this.#appendAndApply({ type: 'fail', id, error: errorShape(error) });
    });
  }

  markUnknown(id, reason) {
    return this.#enqueued(async () => {
      this.#ensureWritable();
      const cur = this.#require(id);
      if (cur.state !== 'RUNNING') throw new LedgerStateError(`Cannot markUnknown from ${cur.state}`);
      return this.#appendAndApply({ type: 'unknown', id, reason: String(reason ?? 'unknown') });
    });
  }

  reconcile(id, result) {
    return this.#enqueued(async () => {
      this.#ensureWritable();
      if (result === undefined) throw new TypeError('Receipt required');
      const cur = this.#require(id);
      if (cur.state !== 'UNKNOWN') throw new LedgerStateError(`Cannot reconcile from ${cur.state}`);
      const safe = serializeBlob(result, 'result');
      return this.#appendAndApply({ type: 'reconcile', id, result: safe });
    });
  }

  async compact() {
    return this.#enqueued(async () => {
      this.#ensureWritable();
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
    await this.#queue.catch(() => {});
    this.#closed = true;
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    try {
      const raw = await this.#fs.readFile(path.join(this.#lockDir, 'owner.json'), 'utf8');
      const holder = JSON.parse(raw);
      if (holder.token === this.#token) {
        await this.#fs.rm(this.#lockDir, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }

  #startHeartbeat() {
    const interval = Math.max(50, Math.floor(this.#staleMs / 2));
    this.#heartbeat = setInterval(() => {
      this.#touchLock().catch(() => {
        this.#compromised = true;
      });
    }, interval);
    this.#heartbeat.unref();
  }

  async #touchLock() {
    if (this.#closed || this.#compromised) return;
    try {
      const ownerPath = path.join(this.#lockDir, 'owner.json');
      const raw = await this.#fs.readFile(ownerPath, 'utf8');
      const holder = JSON.parse(raw);
      if (holder.token !== this.#token) {
        this.#compromised = true;
        return;
      }
      const now = new Date();
      await this.#fs.utimes(this.#lockDir, now, now);
    } catch {
      this.#compromised = true;
    }
  }

  #ensureWritable() {
    if (this.#closed) throw new Error('Ledger is closed');
    if (this.#compromised) throw new LedgerLockedError('lock lost');
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
      try {
        event = JSON.parse(line);
      } catch (e) {
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
        throw new LedgerCorruptError(`corrupt ledger at line ${i + 1}: ${e.message}`);
      }
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

async function readOwner(lockDir, fs) {
  try {
    return JSON.parse(await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function createLockDir(lockDir, token, fs) {
  await fs.mkdir(lockDir);
  const owner = {
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify(owner), 'utf8');
  const now = new Date();
  try {
    await fs.utimes(lockDir, now, now);
  } catch {
    /* ignore */
  }
  return token;
}

async function acquireLock(dir, { lockTimeoutMs, staleMs, beforeStaleRename }, fs) {
  const lockDir = path.join(dir, 'ledger.lock');
  const token = randomBytes(16).toString('hex');
  const started = Date.now();
  let spins = 0;
  const liveStaleAfter = STALE_LIVE_MULTIPLIER * staleMs;
  const esrchGrace = staleMs / 2;

  for (;;) {
    if (++spins > 10_000) throw new LedgerLockedError('lock acquire spin limit');
    try {
      await createLockDir(lockDir, token, fs);
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      let st = null;
      try {
        st = await fs.stat(lockDir);
      } catch (se) {
        if (se && se.code === 'ENOENT') continue;
        throw se;
      }

      const age = Date.now() - st.mtimeMs;
      const owner = await readOwner(lockDir, fs);
      const rememberedToken = owner && typeof owner.token === 'string' ? owner.token : '';
      const dead = owner ? pidDefinitelyDead(owner.pid) : true;
      // ① ESRCH after at least one missed heartbeat (age > staleMs/2) → reclaim.
      //    (fresh mtime + ESRCH alone is ignored: hosts may report false ESRCH.)
      // ② Live/EPERM → only after 4×staleMs mtime age.
      const reclaimable = (dead && age > esrchGrace) || (!dead && age > liveStaleAfter);

      if (!reclaimable) {
        if (!lockTimeoutMs || lockTimeoutMs <= 0) throw new LedgerLockedError();
        if (Date.now() - started >= lockTimeoutMs) throw new LedgerLockedError();
        await sleep(50);
        continue;
      }

      if (typeof beforeStaleRename === 'function') {
        await beforeStaleRename({ lockDir, rememberedToken, staleMs });
      }

      const staleName = `${lockDir}.stale-${token}`;
      try {
        await fs.rename(lockDir, staleName);
      } catch (re) {
        if (re && re.code === 'ENOENT') continue;
        throw re;
      }

      const movedOwner = await readOwner(staleName, fs);
      const movedToken = movedOwner && typeof movedOwner.token === 'string' ? movedOwner.token : '';

      // Only delete if we moved the same stale lock we inspected (token match).
      if (movedToken !== rememberedToken) {
        let restored = false;
        let restoreErr = null;
        try {
          await fs.stat(lockDir);
          // Original name occupied — leave the moved dir in place; do not delete.
        } catch (se) {
          if (se && se.code === 'ENOENT') {
            try {
              await fs.rename(staleName, lockDir);
              restored = true;
            } catch (re2) {
              restoreErr = re2;
            }
          } else {
            restoreErr = se;
          }
        }
        if (restored) {
          throw new LedgerLockedError('stale rename raced; restored foreign lock');
        }
        if (restoreErr) {
          throw new LedgerLockedError(
            `stale rename raced; restore failed: ${restoreErr.message || restoreErr}`,
          );
        }
        throw new LedgerLockedError('stale rename raced; left moved lock in place');
      }

      let movedStat = null;
      try {
        movedStat = await fs.stat(staleName);
      } catch {
        movedStat = null;
      }
      const movedAge = movedStat ? Date.now() - movedStat.mtimeMs : Infinity;
      const movedDead = movedOwner ? pidDefinitelyDead(movedOwner.pid) : true;
      const stillReclaimable =
        (movedDead && movedAge > esrchGrace) || (!movedDead && movedAge > liveStaleAfter);

      if (!stillReclaimable) {
        let lockExists = true;
        try {
          await fs.stat(lockDir);
        } catch (se) {
          if (se && se.code === 'ENOENT') lockExists = false;
          else throw se;
        }
        if (!lockExists) {
          try {
            await fs.rename(staleName, lockDir);
          } catch (re2) {
            throw new LedgerLockedError(
              `stale criteria failed; restore failed: ${re2.message || re2}`,
            );
          }
        }
        throw new LedgerLockedError();
      }

      try {
        await fs.rm(staleName, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      // Loop and mkdir.
    }
  }
}
