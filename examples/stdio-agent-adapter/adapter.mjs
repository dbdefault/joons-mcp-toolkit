/**
 * stdio JSON-RPC 2.0 host adapter (educational).
 * Spawns a child process and exchanges newline-delimited JSON-RPC on stdin/stdout.
 * Contract: host.send(request, { signal }) and Error.phase for multi-host routers.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_LINE_BYTES = 1_048_576;

function phasedError(message, phase) {
  const err = new Error(message);
  if (phase !== undefined) err.phase = phase;
  return err;
}

function validateJsonRpcResponse(body, requestId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw phasedError('stdio response is not a JSON object', 'after_send');
  }
  if (body.jsonrpc !== '2.0') {
    throw phasedError('stdio response jsonrpc must be "2.0"', 'after_send');
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
 * @param {{ command: string, args?: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number, maxLineBytes?: number }} opts
 */
export async function createStdioAgentHost(opts = {}) {
  const command = opts.command;
  if (typeof command !== 'string' || !command) throw new TypeError('command is required');
  const args = opts.args ?? [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;

  let child;
  try {
    child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
    });
  } catch (err) {
    throw phasedError('Failed to start stdio agent process', 'before_send');
  }

  // Spawn can emit error asynchronously (missing binary).
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
    // Some platforms may not emit 'spawn'; fall through shortly.
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
  const pending = new Map(); // id -> { resolve, reject, timer, onAbort }
  // Keep a short stderr tail for local debugging; never put it into thrown messages.
  let stderrTail = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-400);
  });

  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    for (const [, waiters] of pending) {
      clearTimeout(waiters.timer);
      if (waiters.onAbort && waiters.signal) {
        waiters.signal.removeEventListener('abort', waiters.onAbort);
      }
      waiters.reject(phasedError('stdio agent exited before a matching response', 'after_send'));
    }
    pending.clear();
  });

  function rejectAll(err) {
    for (const [, waiters] of pending) {
      clearTimeout(waiters.timer);
      if (waiters.onAbort && waiters.signal) {
        waiters.signal.removeEventListener('abort', waiters.onAbort);
      }
      waiters.reject(err);
    }
    pending.clear();
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > maxLineBytes) {
      rejectAll(phasedError('stdio response line exceeds size limit', 'after_send'));
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      rejectAll(phasedError('stdio response is not valid JSON', 'after_send'));
      return;
    }
    const id = parsed?.id;
    const waiters = pending.get(id);
    if (!waiters) {
      // A JSON-RPC object arrived, but not for any in-flight id → treat as invalid reply.
      if (pending.size > 0) {
        rejectAll(phasedError('stdio response id does not match the request', 'after_send'));
      }
      return;
    }
    pending.delete(id);
    clearTimeout(waiters.timer);
    if (waiters.onAbort && waiters.signal) {
      waiters.signal.removeEventListener('abort', waiters.onAbort);
    }
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

      const line = `${JSON.stringify(request)}\n`;
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
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
          const ok = child.stdin.write(line);
          if (!ok) {
            // backpressure: still consider bytes accepted by the stream API
          }
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
