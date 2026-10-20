/**
 * Local demo: start a mock HTTP JSON-RPC server and call the adapter.
 * No external network required.
 */
import { createHttpAgentHost } from './adapter.mjs';
import { startMockHttpServer } from './mock-server.mjs';

const mock = await startMockHttpServer({ defaultMode: 'ok' });
try {
  const host = createHttpAgentHost({ url: mock.url, timeoutMs: 2000, maxResponseBytes: 64_000 });
  const result = await host.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'demo.echo',
    params: { text: 'hello-from-http' },
  });
  console.log(JSON.stringify({ ok: true, result }, null, 2));
} finally {
  await mock.close();
}
