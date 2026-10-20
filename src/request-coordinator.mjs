import { createHash } from 'node:crypto';

export class RequestConflictError extends Error {
  constructor(id) { super(`Request ID conflict: ${id}`); this.name = 'RequestConflictError'; }
}
export class UnknownOutcomeError extends Error {
  constructor(id, cause) { super(`Outcome unknown for request ${id}`, { cause }); this.name = 'UnknownOutcomeError'; }
}
function fingerprint(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
/**
 * In-memory reference coordinator. Not a durable queue.
 * execute(payload) must be supplied by the caller. Do not retry UNKNOWN automatically.
 */
export class RequestCoordinator {
  #records = new Map();
  get(id) {
    const r = this.#records.get(id);
    return r && { id, state: r.state, fingerprint: r.fingerprint, result: r.result };
  }
  async run(id, payload, execute) {
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('Non-empty request ID required');
    if (typeof execute !== 'function') throw new TypeError('execute must be a function');
    const hash = fingerprint(payload);
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
  /** Deliberate reconciliation, not an implicit retry. */
  reconcile(id, result) {
    const record = this.#records.get(id);
    if (!record || record.state !== 'UNKNOWN') throw new Error('Only UNKNOWN requests can be reconciled');
    if (result === undefined) throw new Error('Receipt required');
    record.result = result;
    record.state = 'SUCCEEDED';
  }
}
