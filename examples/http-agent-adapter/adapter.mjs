/**
 * HTTP JSON-RPC 2.0 host adapter (educational).
 * Contract for multi-host routers: host.send(request, { signal }) and Error.phase.
 * Phases: before_send | after_send | unknown (or omitted when uncertain).
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_048_576;

function phasedError(message, phase) {
  const err = new Error(message);
  if (phase !== undefined) err.phase = phase;
  return err;
}

function classifyFetchFailure(err) {
  const name = err?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return phasedError('HTTP request timed out or was aborted', 'unknown');
  }
  const code = err?.cause?.code || err?.code || err?.cause?.cause?.code;
  const beforeCodes = new Set([
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  ]);
  const afterCodes = new Set([
    'ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET',
  ]);
  if (beforeCodes.has(code)) {
    return phasedError('HTTP connection failed before request bytes were sent', 'before_send');
  }
  if (afterCodes.has(code)) {
    return phasedError('HTTP transport failed after the request was sent', 'after_send');
  }
  // Node fetch often wraps loopback refusals as "fetch failed" with ECONNREFUSED in cause.
  const nested = String(err?.cause?.message || err?.message || '');
  if (/ECONNREFUSED|ENOTFOUND|bad port/i.test(nested)) {
    return phasedError('HTTP connection failed before request bytes were sent', 'before_send');
  }
  if (/ECONNRESET|other side closed|socket/i.test(nested)) {
    return phasedError('HTTP transport failed after the request was sent', 'after_send');
  }
  return phasedError('HTTP transport failed', 'unknown');
}

function validateJsonRpcResponse(body, requestId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw phasedError('HTTP response is not a JSON object', 'after_send');
  }
  if (body.jsonrpc !== '2.0') {
    throw phasedError('HTTP response jsonrpc must be "2.0"', 'after_send');
  }
  // Notifications / server requests must not be treated as success responses.
  if (Object.prototype.hasOwnProperty.call(body, 'method')) {
    throw phasedError('HTTP response must not include method', 'after_send');
  }
  if (!Object.is(body.id, requestId)) {
    throw phasedError('HTTP response id does not match the request', 'after_send');
  }
  const hasResult = Object.prototype.hasOwnProperty.call(body, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(body, 'error');
  if (hasResult && hasError) {
    throw phasedError('HTTP response must not include both result and error', 'after_send');
  }
  if (!hasResult && !hasError) {
    throw phasedError('HTTP response must include result or error', 'after_send');
  }
  return body;
}

async function readBodyCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw phasedError('HTTP response exceeds size limit', 'after_send');
  }
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw phasedError('HTTP response exceeds size limit', 'after_send');
    }
    return text;
  }
  const reader = res.body.getReader();
  let size = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw phasedError('HTTP response exceeds size limit', 'after_send');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * @param {{ url: string, timeoutMs?: number, maxResponseBytes?: number, fetchImpl?: typeof fetch }} opts
 * @returns {{ send: (request: object, opts?: { signal?: AbortSignal }) => Promise<object> }}
 */
export function createHttpAgentHost(opts = {}) {
  const url = opts.url;
  if (typeof url !== 'string' || !url) throw new TypeError('url is required');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async send(request, { signal } = {}) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw phasedError('request must be a JSON-RPC object', 'before_send');
      }
      if (request.jsonrpc !== '2.0') {
        throw phasedError('request.jsonrpc must be "2.0"', 'before_send');
      }
      if (!Object.prototype.hasOwnProperty.call(request, 'id')) {
        throw phasedError('request.id is required', 'before_send');
      }

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) throw phasedError('HTTP request aborted', 'unknown');
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const body = JSON.stringify(request);
        let res;
        try {
          res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body,
            signal: controller.signal,
            redirect: 'error',
          });
        } catch (err) {
          throw classifyFetchFailure(err);
        }

        let text;
        try {
          text = await readBodyCapped(res, maxResponseBytes);
        } catch (err) {
          if (err?.phase) throw err;
          throw phasedError('HTTP response body could not be read', 'after_send');
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw phasedError('HTTP response is not valid JSON', 'after_send');
        }
        return validateJsonRpcResponse(parsed, request.id);
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
