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
  PromotionIntegrityError,
} from './qa-evidence.mjs';

function usage() {
  return `Usage:
  node src/qa-evidence-cli.mjs record --dir DIR --fix SHA --tested SHA --cmd TEXT --exit N --passed N --failed N --output-file FILE [--runner NAME] [--hmac-key-env NAME | --hmac-key-file PATH]
  node src/qa-evidence-cli.mjs check --dir DIR --fix SHA [--strict|--no-strict] [--hmac-key-env NAME | --hmac-key-file PATH]

HMAC secrets must not be passed on the command line.
Use --hmac-key-env NAME (read process.env[NAME]) or --hmac-key-file PATH.
The flag --hmac-key <value> is not accepted.
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

function resolveHmacKey(args) {
  if (Object.prototype.hasOwnProperty.call(args, 'hmac-key')) {
    // Do not echo any provided value.
    throw new Error(
      '--hmac-key is not accepted; pass --hmac-key-env NAME or --hmac-key-file PATH instead',
    );
  }
  const envName = args['hmac-key-env'];
  const filePath = args['hmac-key-file'];
  if (envName && filePath && envName !== true && filePath !== true) {
    throw new Error('use only one of --hmac-key-env or --hmac-key-file');
  }
  if (envName && envName !== true) {
    const value = process.env[envName];
    if (value == null || value === '') {
      throw new Error(`environment variable ${envName} is empty or unset`);
    }
    return value;
  }
  if (filePath && filePath !== true) {
    warnLooseKeyPermissions(filePath);
    return fs.readFileSync(filePath, 'utf8').replace(/\r?\n$/, '');
  }
  return undefined;
}

function warnLooseKeyPermissions(filePath) {
  if (process.platform === 'win32') return;
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if (mode & 0o077) {
      process.stderr.write(
        `warning: hmac key file permissions are loose (mode ${mode.toString(8)}); prefer 0600\n`,
      );
    }
  } catch {
    // Permission probe is best-effort.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help) {
    process.stdout.write(usage());
    process.exit(cmd ? 0 : 2);
  }

  const dir = requireFlag(args, 'dir');
  const hmacKey = resolveHmacKey(args);
  let strict;
  if (args['no-strict'] === true) strict = false;
  else if (args.strict === true) strict = true;
  const store = createEvidenceStore({
    dir,
    hmacKey,
    ...(strict === undefined ? {} : { strict }),
  });

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
    const decision = evaluatePromotion(
      store,
      fixSha,
      strict === undefined ? {} : { strict },
    );
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    process.exit(decision.promotable ? 0 : 1);
  }

  process.stderr.write(`unknown command: ${cmd}\n${usage()}`);
  process.exit(2);
}

main().catch((err) => {
  const name = err?.name || 'Error';
  // Never include secret material; messages are constructed without key values.
  process.stderr.write(`${name}: ${err.message}\n`);
  if (err instanceof PromotionIntegrityError && Array.isArray(err.problems)) {
    for (const p of err.problems) process.stderr.write(`- ${p}\n`);
  }
  void InvalidShaError;
  void InvalidEvidenceError;
  void TamperedEvidenceError;
  void PromotionRefusedError;
  process.exit(1);
});
