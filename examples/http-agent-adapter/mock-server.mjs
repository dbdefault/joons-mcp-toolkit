/**
 * Local mock HTTP JSON-RPC server for adapter demos and tests.
 * Modes: ok | delay | drop | bad-json | wrong-id | both-result-error | huge
 */
import http from 'node:http';
import { once } from 'node:events';

function readRequestBody(req, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {{ defaultMode?: string, delayMs?: number }} [opts]
 */
export async function startMockHttpServer(opts = {}) {
  const defaultMode = opts.defaultMode || 'ok';
  const delayMs = opts.delayMs ?? 3000;

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end('POST only');
      return;
    }

    let raw = '';
    try {
      raw = await readRequestBody(req);
    } catch {
      res.writeHead(413).end('too large');
      return;
    }

    let requestId = null;
    try {
      const parsed = JSON.parse(raw);
      requestId = parsed?.id ?? null;
    } catch {
      // keep null id for malformed inbound; still exercise response modes
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const mode = url.searchParams.get('mode') || defaultMode;

    if (mode === 'drop') {
      req.socket.destroy();
      return;
    }

    if (mode === 'delay') {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    if (mode === 'bad-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not-json');
      return;
    }

    if (mode === 'wrong-id') {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 'not-the-request-id', result: { ok: true } });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (mode === 'both-result-error') {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        result: { ok: true },
        error: { code: -32000, message: 'conflict' },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    if (mode === 'huge') {
      const padding = 'x'.repeat(10_000);
      const body = JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { padding } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    // ok (and delay after wait)
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      result: { echo: true, host: 'host-a' },
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/rpc`;

  return {
    url,
    port,
    async close() {
      server.close();
      await once(server, 'close').catch(() => {});
    },
  };
}
