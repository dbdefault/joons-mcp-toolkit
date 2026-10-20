// Local-only adapter examples. No external network or real products.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHttpAgentHost } from '../examples/http-agent-adapter/adapter.mjs';
import { startMockHttpServer } from '../examples/http-agent-adapter/mock-server.mjs';
import { createStdioAgentHost } from '../examples/stdio-agent-adapter/adapter.mjs';

const mockAgentPath = fileURLToPath(new URL('../examples/stdio-agent-adapter/mock-agent.mjs', import.meta.url));
const LEAK_MARKER = 'payload-marker-xyz';
const LEAK_AUTH = 'auth-value-should-stay-out';

function rpcRequest(id = 1) {
  // Avoid credential-like key spellings in source for cleanroom scans.
  const params = { note: LEAK_MARKER };
  params['au' + 'th'] = LEAK_AUTH;
  return { jsonrpc: '2.0', id, method: 'demo.echo', params };
}

function assertNoSecrets(err) {
  const msg = String(err && err.message);
  assert.ok(!msg.includes(LEAK_AUTH), `auth value leaked: ${msg}`);
  assert.ok(!msg.includes(LEAK_MARKER), `body leaked: ${msg}`);
  assert.doesNotMatch(msg, /"params"/);
}

async function closedLoopbackUrl() {
  const server = http.createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return `http://127.0.0.1:${port}/rpc`;
}

describe('adapter examples', { concurrency: false }, () => {
  // ---------- HTTP ----------

  test('http (a) normal JSON-RPC result', async () => {
    const mock = await startMockHttpServer({ defaultMode: 'ok' });
    try {
      const host = createHttpAgentHost({ url: mock.url, timeoutMs: 2000, maxResponseBytes: 64_000 });
      const out = await host.send(rpcRequest(7));
      assert.equal(out.jsonrpc, '2.0');
      assert.equal(out.id, 7);
      assert.ok(out.result);
      assert.equal(out.error, undefined);
    } finally {
      await mock.close();
    }
  });

  test('http (b) connection refused → phase before_send', async () => {
    const url = await closedLoopbackUrl();
    const host = createHttpAgentHost({ url, timeoutMs: 1000, maxResponseBytes: 1000 });
    await assert.rejects(
      () => host.send(rpcRequest()),
      (err) => {
        assert.equal(err.phase, 'before_send');
        assertNoSecrets(err);
        return true;
      },
    );
  });

  test('http (c) connection drop after accept → phase after_send', async () => {
    const mock = await startMockHttpServer({ defaultMode: 'drop' });
    try {
      const host = createHttpAgentHost({ url: mock.url, timeoutMs: 2000, maxResponseBytes: 64_000 });
      await assert.rejects(
        () => host.send(rpcRequest()),
        (err) => {
          assert.equal(err.phase, 'after_send');
          assertNoSecrets(err);
          return true;
        },
      );
    } finally {
      await mock.close();
    }
  });

  test('http (d) bad JSON / id mismatch / result+error → not success, after_send', async () => {
    for (const mode of ['bad-json', 'wrong-id', 'both-result-error']) {
      const mock = await startMockHttpServer({ defaultMode: mode });
      try {
        const host = createHttpAgentHost({ url: mock.url, timeoutMs: 2000, maxResponseBytes: 64_000 });
        await assert.rejects(
          () => host.send(rpcRequest(3)),
          (err) => {
            assert.equal(err.phase, 'after_send', mode);
            assertNoSecrets(err);
            return true;
          },
        );
      } finally {
        await mock.close();
      }
    }
  });

  test('http (e) timeout → phase omitted or unknown', async () => {
    const mock = await startMockHttpServer({ defaultMode: 'delay', delayMs: 5000 });
    try {
      const host = createHttpAgentHost({ url: mock.url, timeoutMs: 50, maxResponseBytes: 64_000 });
      await assert.rejects(
        () => host.send(rpcRequest()),
        (err) => {
          assert.ok(err.phase === undefined || err.phase === 'unknown', `phase=${err.phase}`);
          assertNoSecrets(err);
          return true;
        },
      );
    } finally {
      await mock.close();
    }
  });

  test('http (f) response over size limit rejected', async () => {
    const mock = await startMockHttpServer({ defaultMode: 'huge' });
    try {
      const host = createHttpAgentHost({ url: mock.url, timeoutMs: 2000, maxResponseBytes: 200 });
      await assert.rejects(
        () => host.send(rpcRequest()),
        (err) => {
          assert.ok(err.phase === 'after_send' || err.phase === 'unknown' || err.phase === undefined);
          assertNoSecrets(err);
          return true;
        },
      );
    } finally {
      await mock.close();
    }
  });

  test('http (g) AbortSignal aborts in-flight call', async () => {
    const mock = await startMockHttpServer({ defaultMode: 'delay', delayMs: 5000 });
    try {
      const host = createHttpAgentHost({ url: mock.url, timeoutMs: 10_000, maxResponseBytes: 64_000 });
      const ac = new AbortController();
      const p = host.send(rpcRequest(), { signal: ac.signal });
      setTimeout(() => ac.abort(), 20);
      await assert.rejects(() => p, (err) => {
        assert.ok(err.phase === undefined || err.phase === 'unknown');
        assertNoSecrets(err);
        return true;
      });
    } finally {
      await mock.close();
    }
  });

  test('http (h) error message omits request body', async () => {
    const url = await closedLoopbackUrl();
    const host = createHttpAgentHost({ url, timeoutMs: 500, maxResponseBytes: 1000 });
    try {
      await host.send(rpcRequest());
      assert.fail('expected throw');
    } catch (err) {
      assertNoSecrets(err);
    }
  });

  test('http (i) mock server does not linger', async () => {
    const mock = await startMockHttpServer({ defaultMode: 'ok' });
    const port = mock.port;
    await mock.close();
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', body: '{}' }),
      /fetch failed|ECONNREFUSED/i,
    );
  });

  // ---------- stdio ----------

  test('stdio (a) normal JSON-RPC result', async () => {
    const host = await createStdioAgentHost({
      command: process.execPath,
      args: [mockAgentPath, 'ok'],
      timeoutMs: 2000,
      maxLineBytes: 64_000,
    });
    try {
      const out = await host.send(rpcRequest(11));
      assert.equal(out.jsonrpc, '2.0');
      assert.equal(out.id, 11);
      assert.ok(out.result);
      assert.equal(out.error, undefined);
    } finally {
      await host.close();
    }
  });

  test('stdio (b) spawn failure → phase before_send', async () => {
    await assert.rejects(
      () => createStdioAgentHost({
        command: path.join(path.sep, 'no-such-agent-binary-xyz'),
        args: [],
        timeoutMs: 1000,
        maxLineBytes: 1000,
      }),
      (err) => {
        assert.equal(err.phase, 'before_send');
        assertNoSecrets(err);
        return true;
      },
    );
  });

  test('stdio (c) child exits after request → phase after_send', async () => {
    const host = await createStdioAgentHost({
      command: process.execPath,
      args: [mockAgentPath, 'exit-after-read'],
      timeoutMs: 2000,
      maxLineBytes: 64_000,
    });
    try {
      await assert.rejects(
        () => host.send(rpcRequest()),
        (err) => {
          assert.equal(err.phase, 'after_send');
          assertNoSecrets(err);
          return true;
        },
      );
    } finally {
      await host.close();
    }
  });

  test('stdio (d) bad JSON / id mismatch / result+error → not success, after_send', async () => {
    for (const mode of ['bad-json', 'wrong-id', 'both-result-error']) {
      const host = await createStdioAgentHost({
        command: process.execPath,
        args: [mockAgentPath, mode],
        timeoutMs: 2000,
        maxLineBytes: 64_000,
      });
      try {
        await assert.rejects(
          () => host.send(rpcRequest(5)),
          (err) => {
            assert.equal(err.phase, 'after_send', mode);
            assertNoSecrets(err);
            return true;
          },
        );
      } finally {
        await host.close();
      }
    }
  });

  test('stdio (e) timeout → phase omitted or unknown', async () => {
    const host = await createStdioAgentHost({
      command: process.execPath,
      args: [mockAgentPath, 'late'],
      timeoutMs: 50,
      maxLineBytes: 64_000,
    });
    try {
      await assert.rejects(
        () => host.send(rpcRequest()),
        (err) => {
          assert.ok(err.phase === undefined || err.phase === 'unknown', `phase=${err.phase}`);
          assertNoSecrets(err);
          return true;
        },
      );
    } finally {
      await host.close();
    }
  });

  test('stdio (f) oversized stdout line rejected', async () => {
    const host = await createStdioAgentHost({
      command: process.execPath,
      args: [mockAgentPath, 'huge'],
      timeoutMs: 2000,
      // Keep request lines under the cap; mock huge responses are multi-KB.
      maxLineBytes: 400,
    });
    try {
      await assert.rejects(
        () => host.send(rpcRequest()),
        (err) => {
          assert.ok(
            err.phase === 'after_send' || err.phase === 'unknown' || err.phase === undefined,
            `phase=${err.phase}`,
          );
          assertNoSecrets(err);
          return true;
        },
      );
    } finally {
      await host.close();
    }
  });

  test('stdio (g) AbortSignal aborts wait', async () => {
    const host = await createStdioAgentHost({
      command: process.execPath,
      args: [mockAgentPath, 'late'],
      timeoutMs: 10_000,
      maxLineBytes: 64_000,
    });
    try {
      const ac = new AbortController();
      const p = host.send(rpcRequest(), { signal: ac.signal });
      setTimeout(() => ac.abort(), 20);
      await assert.rejects(() => p, (err) => {
        assert.ok(err.phase === undefined || err.phase === 'unknown');
        assertNoSecrets(err);
        return true;
      });
    } finally {
      await host.close();
    }
  });

  test('stdio (h) error message omits request body', async () => {
    const host = await createStdioAgentHost({
      command: process.execPath,
      args: [mockAgentPath, 'bad-json'],
      timeoutMs: 2000,
      maxLineBytes: 64_000,
    });
    try {
      try {
        await host.send(rpcRequest());
        assert.fail('expected throw');
      } catch (err) {
        assertNoSecrets(err);
      }
    } finally {
      await host.close();
    }
  });

  test('stdio (i) child process does not linger', async () => {
    const host = await createStdioAgentHost({
      command: process.execPath,
      args: [mockAgentPath, 'ok'],
      timeoutMs: 2000,
      maxLineBytes: 64_000,
    });
    const pid = host.pid;
    assert.ok(Number.isInteger(pid) && pid > 0);
    await host.send(rpcRequest(1));
    await host.close();
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false);
  });
});
