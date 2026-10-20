/**
 * Fake stdio JSON-RPC agent for local demos and tests.
 * Usage: node mock-agent.mjs <mode>
 * Modes:
 *   ok | exit-after-read | bad-json | wrong-id | both-result-error | late | huge
 *   notify-then-ok | server-req-then-ok | unmatched-then-ok | duplicate-id
 *   malformed-then-ok | ok-with-notify
 */
import readline from 'node:readline';

const mode = process.argv[2] || 'ok';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function reply(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function okResult(id) {
  reply({ jsonrpc: '2.0', id: id ?? null, result: { echo: true, host: 'host-b' } });
}

rl.on('line', async (line) => {
  let req = null;
  try {
    req = JSON.parse(line);
  } catch {
    // ignore parse of inbound for fault modes that still need to answer
  }

  if (mode === 'exit-after-read') {
    process.exit(0);
  }

  if (mode === 'late') {
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (mode === 'bad-json') {
    process.stdout.write('{not-json\n');
    return;
  }

  if (mode === 'wrong-id') {
    reply({ jsonrpc: '2.0', id: 'not-the-request-id', result: { ok: true } });
    return;
  }

  if (mode === 'both-result-error') {
    reply({
      jsonrpc: '2.0',
      id: req?.id ?? null,
      result: { ok: true },
      error: { code: -32000, message: 'conflict' },
    });
    return;
  }

  if (mode === 'huge') {
    reply({ jsonrpc: '2.0', id: req?.id ?? null, result: { padding: 'y'.repeat(5000) } });
    return;
  }

  if (mode === 'notify-then-ok') {
    reply({ jsonrpc: '2.0', method: 'demo/log', params: { level: 'info' } });
    okResult(req?.id);
    return;
  }

  if (mode === 'server-req-then-ok') {
    reply({
      jsonrpc: '2.0',
      id: 'server-1',
      method: 'sampling/createMessage',
      params: { prompt: 'x' },
    });
    okResult(req?.id);
    return;
  }

  if (mode === 'unmatched-then-ok') {
    reply({ jsonrpc: '2.0', id: 'orphan-id', result: { orphan: true } });
    okResult(req?.id);
    return;
  }

  if (mode === 'duplicate-id') {
    reply({ jsonrpc: '2.0', id: req?.id ?? null, result: { which: 'first' } });
    reply({ jsonrpc: '2.0', id: req?.id ?? null, result: { which: 'second' } });
    return;
  }

  if (mode === 'malformed-then-ok') {
    process.stdout.write('{not-json\n');
    okResult(req?.id);
    return;
  }

  if (mode === 'ok-with-notify') {
    reply({ jsonrpc: '2.0', method: 'demo/log', params: { n: req?.id } });
    okResult(req?.id);
    return;
  }

  // ok (and late after wait)
  okResult(req?.id);
});
