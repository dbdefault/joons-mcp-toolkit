/**
 * Local demo: spawn a mock stdio JSON-RPC agent and call the adapter.
 * No external network required.
 */
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createStdioAgentHost } from './adapter.mjs';

const mockAgent = fileURLToPath(new URL('./mock-agent.mjs', import.meta.url));
const host = await createStdioAgentHost({
  command: process.execPath,
  args: [mockAgent, 'ok'],
  timeoutMs: 2000,
  maxLineBytes: 64_000,
});

try {
  const result = await host.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'demo.echo',
    params: { text: 'hello-from-stdio' },
  });
  console.log(JSON.stringify({ ok: true, result }, null, 2));
} finally {
  await host.close();
}
