#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  createEvidenceStore,
  evaluatePromotion,
  InvalidShaError,
  InvalidEvidenceError,
  TamperedEvidenceError,
  PromotionRefusedError,
} from './qa-evidence.mjs';

function usage() {
  return `Usage:
  node src/qa-evidence-cli.mjs record --dir DIR --fix SHA --tested SHA --cmd TEXT --exit N --passed N --failed N --output-file FILE [--runner NAME] [--hmac-key KEY]
  node src/qa-evidence-cli.mjs check --dir DIR --fix SHA [--strict] [--hmac-key KEY]
`;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function requireFlag(args, name) {
  if (args[name] == null || args[name] === true || args[name] === '') {
    throw new Error(`missing --${name}`);
  }
  return args[name];
}

function toInt(label, value) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer`);
  return n;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help) {
    process.stdout.write(usage());
    process.exit(cmd ? 0 : 2);
  }

  const dir = requireFlag(args, 'dir');
  const hmacKey = args['hmac-key'] == null || args['hmac-key'] === true ? undefined : args['hmac-key'];
  const store = createEvidenceStore({ dir, hmacKey, strict: args.strict === true });

  if (cmd === 'record') {
    const outputFile = requireFlag(args, 'output-file');
    const output = fs.readFileSync(outputFile);
    const outputHash = createHash('sha256').update(output).digest('hex');
    const result = store.recordEvidence({
      fixSha: requireFlag(args, 'fix'),
      testedSha: requireFlag(args, 'tested'),
      command: requireFlag(args, 'cmd'),
      exitCode: toInt('exit', requireFlag(args, 'exit')),
      passed: toInt('passed', requireFlag(args, 'passed')),
      failed: toInt('failed', requireFlag(args, 'failed')),
      outputHash,
      runner: args.runner === true ? undefined : args.runner,
    });
    process.stdout.write(`${JSON.stringify({ evidenceId: result.evidenceId, created: result.created }, null, 2)}\n`);
    process.exit(0);
  }

  if (cmd === 'check') {
    const fixSha = requireFlag(args, 'fix');
    const decision = evaluatePromotion(store, fixSha, { strict: args.strict === true });
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    process.exit(decision.promotable ? 0 : 1);
  }

  process.stderr.write(`unknown command: ${cmd}\n${usage()}`);
  process.exit(2);
}

main().catch((err) => {
  const known = [InvalidShaError, InvalidEvidenceError, TamperedEvidenceError, PromotionRefusedError, Error];
  process.stderr.write(`${err?.name || 'Error'}: ${err.message}\n`);
  void known;
  process.exit(1);
});
