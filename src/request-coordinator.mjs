import { createHash } from 'node:crypto';

export class RequestConflictError extends Error {
  constructor(id) {
    super(`Request ID conflict: ${id}`);
    this.name = 'RequestConflictError';
  }
}
export class UnknownOutcomeError extends Error {
  constructor(id, cause) {
    super(`Outcome unknown for request ${id}`, { cause });
    this.name = 'UnknownOutcomeError';
  }
}
function fingerprint(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function reviveError(shape) {
  const error = new Error(shape?.message || 'Error');
  error.name = shape?.name || 'Error';
  if (shape && shape.code !== undefined) error.code = shape.code;
  return error;
}

/**
 * In-memory reference coordinator. Optional durable ledger via `{ ledger }`.
 * execute(payload) must be supplied by the caller. Do not retry UNKNOWN automatically.
 */
export class RequestCoordinator {
  #records = new Map();
  #ledger = null;

  constructor(options = {}) {
    this.#ledger = options.ledger ?? null;
    if (this.#ledger) {
      for (const rec of this.#ledger.list({})) {
        this.#hydrate(rec);
      }
    }
  }

  #hydrate(rec) {
    if (!rec) return;
    const row = {
      state: rec.state,
      fingerprint: rec.fingerprint,
      result: rec.result,
      error: rec.error ? reviveError(rec.error) : undefined,
      reason: rec.reason,
    };
    const prev = this.#records.get(rec.id);
    if (prev?.promise) row.promise = prev.promise;
    this.#records.set(rec.id, row);
  }

  get(id) {
    const r = this.#records.get(id);
    return r && { id, state: r.state, fingerprint: r.fingerprint, result: r.result };
  }

  async run(id, payload, execute) {
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('Non-empty request ID required');
    if (typeof execute !== 'function') throw new TypeError('execute must be a function');
    const hash = fingerprint(payload);

    if (this.#ledger) {
      return this.#runDurable(id, payload, hash, execute);
    }

    const prior = this.#records.get(id);
    if (prior) {
      if (prior.fingerprint !== hash) throw new RequestConflictError(id);
      if (prior.state === 'UNKNOWN') throw new UnknownOutcomeError(id);
      if (prior.state === 'FAILED') throw prior.error;
      if (prior.state === 'SUCCEEDED') return prior.result;
      return prior.promise;
    }
    const record = { state: 'RUNNING', fingerprint: hash };
    this.#records.set(id, record);
    record.promise = (async () => {
      try {
        const result = await execute(payload);
        if (result === undefined) throw new Error('Missing execution receipt');
        record.result = result;
        record.state = 'SUCCEEDED';
        return result;
      } catch (error) {
        record.error = error;
        record.state = error?.outcomeUnknown === true ? 'UNKNOWN' : 'FAILED';
        throw error;
      }
    })();
    return record.promise;
  }

  async #runDurable(id, payload, hash, execute) {
    const local0 = this.#records.get(id);
    if (local0?._durableReconcile) {
      await local0._durableReconcile;
      delete local0._durableReconcile;
    }
    if (local0?.state === 'SUCCEEDED' && local0.fingerprint === hash) {
      return local0.result;
    }

    // Terminal / conflict checks from durable state before any new accept.
    const existing = this.#ledger.get(id);
    if (existing) {
      if (existing.fingerprint !== hash) throw new RequestConflictError(id);
      if (existing.state === 'SUCCEEDED') {
        this.#hydrate(existing);
        return existing.result;
      }
      if (existing.state === 'FAILED') {
        this.#hydrate(existing);
        throw reviveError(existing.error);
      }
      if (existing.state === 'UNKNOWN') {
        this.#hydrate(existing);
        throw new UnknownOutcomeError(id);
      }
    }

    const local = this.#records.get(id);
    if (local?.promise && local.fingerprint === hash) {
      return local.promise;
    }

    const accepted = await this.#ledger.accept(id, payload);
    this.#hydrate(this.#ledger.get(id));

    if (!accepted.created) {
      const prior = this.#records.get(id);
      if (prior.fingerprint !== hash) throw new RequestConflictError(id);
      if (prior.state === 'UNKNOWN') throw new UnknownOutcomeError(id);
      if (prior.state === 'FAILED') throw prior.error || reviveError(this.#ledger.get(id).error);
      if (prior.state === 'SUCCEEDED') return prior.result;
      if (prior.state === 'RUNNING' && prior.promise) return prior.promise;
      if (prior.state === 'RUNNING') throw new UnknownOutcomeError(id);
      // ACCEPTED: continue to execute in this process
    }

    const record = this.#records.get(id) || { state: 'ACCEPTED', fingerprint: hash };
    this.#records.set(id, record);
    if (record.promise) return record.promise;

    record.promise = (async () => {
      try {
        const cur = this.#ledger.get(id);
        if (!cur) throw new Error('Missing ledger record');
        if (cur.state === 'SUCCEEDED') {
          this.#hydrate(cur);
          return cur.result;
        }
        if (cur.state === 'FAILED') {
          this.#hydrate(cur);
          throw reviveError(cur.error);
        }
        if (cur.state === 'UNKNOWN') {
          this.#hydrate(cur);
          throw new UnknownOutcomeError(id);
        }
        if (cur.state === 'ACCEPTED') {
          await this.#ledger.markRunning(id);
          this.#hydrate(this.#ledger.get(id));
        }
        const result = await execute(payload);
        if (result === undefined) throw new Error('Missing execution receipt');
        await this.#ledger.succeed(id, result);
        this.#hydrate(this.#ledger.get(id));
        return result;
      } catch (error) {
        if (error instanceof RequestConflictError || error instanceof UnknownOutcomeError) throw error;
        if (error?.name === 'LedgerStateError') throw error;
        try {
          const st = this.#ledger.get(id)?.state;
          if (error?.outcomeUnknown === true && st === 'RUNNING') {
            await this.#ledger.markUnknown(id, error.message || 'unknown');
            this.#hydrate(this.#ledger.get(id));
          } else if (st === 'RUNNING') {
            await this.#ledger.fail(id, error);
            this.#hydrate(this.#ledger.get(id));
          }
        } catch {
          /* ledger may be closed during crash simulation */
        }
        throw error;
      }
    })();
    return record.promise;
  }

  /** Deliberate reconciliation, not an implicit retry. */
  reconcile(id, result) {
    const record = this.#records.get(id);
    if (!record || record.state !== 'UNKNOWN') throw new Error('Only UNKNOWN requests can be reconciled');
    if (result === undefined) throw new Error('Receipt required');
    if (this.#ledger) {
      // Keep sync API: update memory immediately; durable write is awaited on next run().
      const done = this.#ledger.reconcile(id, result).then((rec) => {
        this.#hydrate(rec);
      });
      record.result = result;
      record.state = 'SUCCEEDED';
      record._durableReconcile = done;
      return;
    }
    record.result = result;
    record.state = 'SUCCEEDED';
  }
}
