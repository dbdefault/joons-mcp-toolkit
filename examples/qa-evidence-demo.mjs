import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createEvidenceStore,
  evaluatePromotion,
  promote,
} from '../src/qa-evidence.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ev-demo-'));
const fixSha = '0123456789abcdef0123456789abcdef01234567';
const outputHash = createHash('sha256').update('demo test output').digest('hex');

const store = createEvidenceStore({ dir });
const saved = store.recordEvidence({
  fixSha,
  testedSha: fixSha,
  command: 'node --test',
  exitCode: 0,
  passed: 2,
  failed: 0,
  outputHash,
  runner: 'demo',
});

console.log('recorded', saved.evidenceId, 'created=', saved.created);
console.log('evaluate', evaluatePromotion(store, fixSha));
console.log('promote', promote(store, fixSha, { approver: 'demo-user' }));
console.log('store dir', dir);
