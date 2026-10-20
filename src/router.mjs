import { createHash } from 'node:crypto';
export { HostUnavailableError, UnknownDeliveryError } from './routing-errors.mjs';

const DEFAULT_MAX_RECORDS = 10_000;
const ERROR_MESSAGE_LIMIT = 200;

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sanitizeMessage(input) {
  let text = input == null ? '' : String(input);
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > ERROR_MESSAGE_LIMIT) text = text.slice(0, ERROR_MESSAGE_LIMIT);
  return text;
}

function publicError(err) {
  const message = sanitizeMessage(err?.message ?? err);
  return { message: message || 'error' };
}

function createMemoryStore() {
  const map = new Map();
  return {
    get(id) {
      return map.get(id);
    },
    set(id, record) {
      map.set(id, record);
    },
    delete(id) {
      map.delete(id);
    },
    entries() {
      return map.entries();
    },
    get size() {
      return map.size;
    },
  };
}

function validateHosts(hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new TypeError('hosts must be a non-empty array');
  }
  const seen = new Set();
  for (const h of hosts) {
    if (!h || typeof h !== 'object') throw new TypeError('host entry must be an object');
    const id = h.id;
    if (typeof id !== 'string' || !id.trim()) {
      throw new TypeError('host id must be a non-empty string');
    }
    if (seen.has(id)) throw new TypeError(`duplicate host id: ${id}`);
    seen.add(id);
    if (typeof h.send !== 'function') {
      throw new TypeError(`host send must be a function (${id})`);
    }
  }
}

function sortHosts(hosts) {
  return hosts
    .map((h, index) => ({ host: h, index, priority: Number.isFinite(h.priority) ? h.priority : 0 }))
    .sort((a, b) => (a.priority - b.priority) || (a.index - b.index))
    .map((x) => x.host);
}

function isBeforeSendPhase(phase) {
  return phase === 'before_send';
}

/**
 * Multi-host request router (in-memory by default).
 * Explicit target never falls back. Unspecified target may fall back only on
 * proven pre-send failure (isAvailable===false or error.phase==='before_send').
 * After send starts with unknown/after_send outcome, do not contact another host.
 */
export function createRouter(options = {}) {
  const { hosts, now = () => Date.now(), store, maxRecords = DEFAULT_MAX_RECORDS } = options;
  validateHosts(hosts);
  const hostList = hosts.slice();
  const byId = new Map(hostList.map((h) => [h.id, h]));
  const ordered = sortHosts(hostList);
  const memory = store ? null : createMemoryStore();
  const max = Number.isFinite(maxRecords) && maxRecords > 0 ? Math.floor(maxRecords) : DEFAULT_MAX_RECORDS;

  function getRecord(id) {
    return store ? store.get(id) : memory.get(id);
  }

  function setRecord(id, record) {
    if (store) store.set(id, record);
    else memory.set(id, record);
  }

  function evictIfNeeded() {
    if (store) return; // custom stores own their retention
    if (memory.size <= max) return;
    const completed = [];
    for (const [id, rec] of memory.entries()) {
      if (rec && rec.settled) completed.push([id, rec.completedAt ?? 0]);
    }
    completed.sort((a, b) => a[1] - b[1]);
    let need = memory.size - max;
    for (const [id] of completed) {
      if (need <= 0) break;
      memory.delete(id);
      need -= 1;
    }
  }

  async function dispatchOne(host, request, signal) {
    if (typeof host.isAvailable === 'function') {
      let available = true;
      try {
        // Adapters may expose sync or async availability checks.
        available = (await Promise.resolve().then(() => host.isAvailable())) !== false;
      } catch (err) {
        return {
          attempt: { host: host.id, outcome: 'error', phase: 'before_send' },
          status: 'FAILED',
          error: publicError(err),
        };
      }
      if (!available) {
        return {
          attempt: { host: host.id, outcome: 'skipped', phase: 'before_send' },
          status: 'FAILED',
          error: { message: 'unavailable' },
        };
      }
    }

    if (signal?.aborted) {
      return {
        attempt: { host: host.id, outcome: 'error', phase: 'before_send' },
        status: 'FAILED',
        error: { message: 'aborted' },
      };
    }

    const ctx = { signal, hostId: host.id };
    try {
      const value = await Promise.resolve().then(() => host.send(request, ctx));
      return {
        attempt: { host: host.id, outcome: 'ok' },
        status: 'SUCCEEDED',
        value,
      };
    } catch (err) {
      const phase = err?.phase;
      if (isBeforeSendPhase(phase)) {
        return {
          attempt: { host: host.id, outcome: 'error', phase: 'before_send' },
          status: 'FAILED',
          error: publicError(err),
        };
      }
      // after_send, missing, or unrecognized → UNKNOWN (fail-closed)
      const normalized =
        phase === 'after_send' ? 'after_send' : phase == null || phase === '' ? undefined : String(phase);
      const attempt = { host: host.id, outcome: 'error' };
      if (normalized !== undefined) attempt.phase = normalized;
      return {
        attempt,
        status: 'UNKNOWN',
        error: publicError(err),
      };
    }
  }

  async function executeRoute({ requestId, request, target, signal }) {
    const attempts = [];

    if (target != null) {
      if (typeof target !== 'string' || !target.trim()) {
        return {
          status: 'FAILED',
          host: null,
          attempts,
          error: { message: 'invalid target' },
        };
      }
      const host = byId.get(target);
      if (!host) {
        return {
          status: 'FAILED',
          host: null,
          attempts,
          error: { message: `unknown target: ${sanitizeMessage(target)}` },
        };
      }
      const outcome = await dispatchOne(host, request, signal);
      attempts.push(outcome.attempt);
      const result = {
        status: outcome.status,
        host: host.id,
        attempts,
      };
      if (outcome.status === 'SUCCEEDED') result.value = outcome.value;
      else result.error = outcome.error;
      return result;
    }

    for (const host of ordered) {
      const outcome = await dispatchOne(host, request, signal);
      attempts.push(outcome.attempt);
      if (outcome.status === 'SUCCEEDED') {
        return {
          status: 'SUCCEEDED',
          host: host.id,
          attempts,
          value: outcome.value,
        };
      }
      if (outcome.status === 'UNKNOWN') {
        return {
          status: 'UNKNOWN',
          host: host.id,
          attempts,
          error: outcome.error,
        };
      }
      // FAILED with before_send / skipped → try next
      if (outcome.attempt.phase === 'before_send') continue;
      // Defensive: treat other failures as UNKNOWN
      return {
        status: 'UNKNOWN',
        host: host.id,
        attempts,
        error: outcome.error,
      };
    }

    return {
      status: 'FAILED',
      host: attempts.length ? attempts[attempts.length - 1].host : null,
      attempts,
      error: { message: 'all hosts failed before send' },
    };
  }

  async function route(input = {}) {
    const { requestId, request, target, signal } = input;
    if (typeof requestId !== 'string' || !requestId.trim()) {
      return {
        status: 'FAILED',
        host: null,
        attempts: [],
        error: { message: 'requestId required' },
      };
    }

    const hash = fingerprint(request);
    const prior = getRecord(requestId);
    if (prior) {
      if (prior.fingerprint !== hash) {
        return {
          status: 'FAILED',
          host: prior.result?.host ?? null,
          attempts: prior.result?.attempts ? prior.result.attempts.slice() : [],
          error: { message: 'conflict: same requestId with different request' },
        };
      }
      if (prior.settled) {
        return cloneResult(prior.result);
      }
      return prior.promise.then(cloneResult);
    }

    const record = {
      fingerprint: hash,
      settled: false,
      createdAt: now(),
    };
    setRecord(requestId, record);
    evictIfNeeded();

    record.promise = (async () => {
      const result = await executeRoute({ requestId, request, target, signal });
      record.result = freezeResult(result);
      record.settled = true;
      record.completedAt = now();
      evictIfNeeded();
      return record.result;
    })();

    return record.promise.then(cloneResult);
  }

  return { route };
}

function freezeResult(result) {
  return {
    status: result.status,
    host: result.host,
    attempts: (result.attempts || []).map((a) => ({ ...a })),
    ...(result.status === 'SUCCEEDED' ? { value: result.value } : {}),
    ...(result.error ? { error: { ...result.error } } : {}),
  };
}

function cloneResult(result) {
  return freezeResult(result);
}
