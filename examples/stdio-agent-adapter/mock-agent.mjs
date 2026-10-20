/**
 * Fake stdio JSON-RPC agent for local demos and tests.
 * Usage: node mock-agent.mjs <mode>
 * Modes: ok | exit-after-read | bad-json | wrong-id | both-result-error | late | huge
 */
import readline from 'node:readline';

const mode = process.argv[2] || 'ok';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function reply(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
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

  // ok (and late after wait)
  reply({
    jsonrpc: '2.0',
    id: req?.id ?? null,
    result: { echo: true, host: 'host-b' },
  });
});
