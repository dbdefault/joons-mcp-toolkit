/**
 * stdio JSON-RPC 2.0 host adapter (educational).
 * Spawns a child process and exchanges newline-delimited JSON-RPC on stdin/stdout.
 * Contract: host.send(request, { signal }) and Error.phase for multi-host routers.
 *
 * Incoming lines are classified per JSON-RPC 2.0:
 *   response       — id present, method absent, result XOR error
 *   notification   — method present, id absent
 *   server_request — method and id both present
 *   malformed      — anything else / bad JSON / wrong jsonrpc
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_LINE_BYTES = 1_048_576;
/** Cap remembered completed response ids (insertion-order eviction of oldest). */
export const COMPLETED_IDS_LIMIT = 1024;

/** Bounded Set of response ids; Map keeps insertion order for eviction. */
export class BoundedIdSet {
  #map = new Map();
  #limit;
  constructor(limit = COMPLETED_IDS_LIMIT) {
    this.#limit = Math.max(1, Number(limit) || COMPLETED_IDS_LIMIT);
  }
  has(id) {
    return this.#map.has(id);
  }
  add(id) {
    if (this.#map.has(id)) return;
    this.#map.set(id, true);
    while (this.#map.size > this.#limit) {
      const oldest = this.#map.keys().next().value;
      this.#map.delete(oldest);
    }
  }
  get size() {
    return this.#map.size;
  }
}

function phasedError(message, phase) {
  const err = new Error(message);
  if (phase !== undefined) err.phase = phase;
  return err;
}

function callSafe(fn, arg) {
  if (typeof fn !== 'function') return;
  try {
    fn(arg);
  } catch {
    // Callback failures must not break the adapter.
  }
}

/**
 * @param {unknown} msg
 * @returns {'response'|'notification'|'server_request'|'malformed'}
 */
export function classifyJsonRpcMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'malformed';
  if (msg.jsonrpc !== '2.0') return 'malformed';
  const hasMethod = Object.prototype.hasOwnProperty.call(msg, 'method');
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  const hasResult = Object.prototype.hasOwnProperty.call(msg, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(msg, 'error');

  if (hasMethod && !hasId) return 'notification';
  if (hasMethod && hasId) return 'server_request';
  if (!hasMethod && hasId && (hasResult || hasError)) return 'response';
  return 'malformed';
}

function validateJsonRpcResponse(body, requestId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw phasedError('stdio response is not a JSON object', 'after_send');
  }
  if (body.jsonrpc !== '2.0') {
    throw phasedError('stdio response jsonrpc must be "2.0"', 'after_send');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'method')) {
    throw phasedError('stdio response must not include method', 'after_send');
  }
  if (!Object.is(body.id, requestId)) {
    throw phasedError('stdio response id does not match the request', 'after_send');
  }
  const hasResult = Object.prototype.hasOwnProperty.call(body, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(body, 'error');
  if (hasResult && hasError) {
    throw phasedError('stdio response must not include both result and error', 'after_send');
  }
  if (!hasResult && !hasError) {
    throw phasedError('stdio response must include result or error', 'after_send');
  }
  return body;
}

/**
 * @param {{
 *   command: string,
 *   args?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   maxLineBytes?: number,
 *   onNotification?: (msg: object) => void,
 *   onServerRequest?: (msg: object) => void,
 *   onProtocolError?: (info: object) => void,
 *   replyMethodNotFound?: boolean,
 * }} opts
 */
export async function createStdioAgentHost(opts = {}) {
  const command = opts.command;
  if (typeof command !== 'string' || !command) throw new TypeError('command is required');
  const args = opts.args ?? [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const replyMethodNotFound = opts.replyMethodNotFound === true;

  let child;
  try {
    child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
    });
  } catch {
    throw phasedError('Failed to start stdio agent process', 'before_send');
  }

  const spawnFailure = await new Promise((resolve) => {
    const onError = (err) => {
      cleanupListeners();
      resolve(err);
    };
    const onSpawn = () => {
      cleanupListeners();
      resolve(null);
    };
    const cleanupListeners = () => {
      child.off('error', onError);
      child.off('spawn', onSpawn);
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
    setTimeout(() => {
      if (child.pid) {
        cleanupListeners();
        resolve(null);
      }
    }, 50);
  });

  if (spawnFailure || !child.pid) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    throw phasedError('Failed to start stdio agent process', 'before_send');
  }

  let closed = false;
  let exitInfo = null;
  const pending = new Map();
  const completedIds = new BoundedIdSet(opts.completedIdsLimit ?? COMPLETED_IDS_LIMIT);
  let stderrTail = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-400);
  });

  function clearWaiter(waiters) {
    clearTimeout(waiters.timer);
    if (waiters.onAbort && waiters.signal) {
      waiters.signal.removeEventListener('abort', waiters.onAbort);
    }
  }

  function rejectAll(err) {
    for (const [, waiters] of pending) {
      clearWaiter(waiters);
      waiters.reject(err);
    }
    pending.clear();
  }

  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    rejectAll(phasedError('stdio agent exited before a matching response', 'after_send'));
  });

  function noteProtocolError(info) {
    callSafe(opts.onProtocolError, info);
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > maxLineBytes) {
      // Oversized lines corrupt framing; fail in-flight work (existing contract).
      rejectAll(phasedError('stdio response line exceeds size limit', 'after_send'));
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      noteProtocolError({ kind: 'malformed', message: 'stdio line is not valid JSON' });
      return;
    }

    const kind = classifyJsonRpcMessage(parsed);

    if (kind === 'notification') {
      callSafe(opts.onNotification, parsed);
      return;
    }

    if (kind === 'server_request') {
      callSafe(opts.onServerRequest, parsed);
      if (replyMethodNotFound) {
        try {
          const errLine = `${JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            error: { code: -32601, message: 'Method not found' },
          })}\n`;
          child.stdin.write(errLine);
        } catch {
          // ignore write failures for optional replies
        }
      }
      return;
    }

    if (kind === 'malformed') {
      noteProtocolError({ kind: 'malformed', message: 'stdio line is not a valid JSON-RPC 2.0 message', value: parsed });
      return;
    }

    // kind === 'response'
    const id = parsed.id;
    if (completedIds.has(id)) {
      noteProtocolError({ kind: 'duplicate_response', message: 'duplicate response id', id });
      return;
    }

    const waiters = pending.get(id);
    if (!waiters) {
      noteProtocolError({ kind: 'unmatched_response', message: 'response id unmatched by in-flight requests', id });
      return;
    }

    pending.delete(id);
    clearWaiter(waiters);
    completedIds.add(id);
    try {
      waiters.resolve(validateJsonRpcResponse(parsed, waiters.expectedId));
    } catch (err) {
      waiters.reject(err);
    }
  });

  async function close() {
    if (closed) return;
    closed = true;
    rl.close();
    try { child.stdin.end(); } catch { /* ignore */ }
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 500);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  return {
    pid: child.pid,
    get completedIdsSize() {
      return completedIds.size;
    },
    async send(request, { signal } = {}) {
      if (closed || exitInfo) {
        throw phasedError('stdio agent is not running', 'before_send');
      }
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw phasedError('request must be a JSON-RPC object', 'before_send');
      }
      if (request.jsonrpc !== '2.0') {
        throw phasedError('request.jsonrpc must be "2.0"', 'before_send');
      }
      if (!Object.prototype.hasOwnProperty.call(request, 'id')) {
        throw phasedError('request.id is required', 'before_send');
      }
      if (pending.has(request.id)) {
        throw phasedError('duplicate in-flight request id', 'before_send');
      }

      const outLine = `${JSON.stringify(request)}\n`;
      if (Buffer.byteLength(outLine, 'utf8') > maxLineBytes) {
        throw phasedError('request line exceeds size limit', 'before_send');
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          if (onAbort && signal) signal.removeEventListener('abort', onAbort);
          reject(phasedError('stdio request timed out or was aborted', 'unknown'));
        }, timeoutMs);

        let onAbort;
        if (signal) {
          if (signal.aborted) {
            clearTimeout(timer);
            reject(phasedError('stdio request aborted', 'unknown'));
            return;
          }
          onAbort = () => {
            pending.delete(request.id);
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(phasedError('stdio request aborted', 'unknown'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }

        pending.set(request.id, { resolve, reject, timer, onAbort, signal, expectedId: request.id });

        try {
          child.stdin.write(outLine);
        } catch {
          pending.delete(request.id);
          clearTimeout(timer);
          if (onAbort && signal) signal.removeEventListener('abort', onAbort);
          reject(phasedError('failed to write request to stdio agent', 'after_send'));
        }
      });
    },
    close,
  };
}
