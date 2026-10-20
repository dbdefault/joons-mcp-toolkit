import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createEvidenceStore,
  evaluatePromotion,
  promote,
  verifyPromotions,
  sha256Hex,
  TamperedEvidenceError,
  PromotionIntegrityError,
  PromotionRefusedError,
} from '../src/qa-evidence.mjs';

const FIX = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FIX2 = 'cccccccccccccccccccccccccccccccccccccccc';
const OUT = createHash('sha256').update('sample-output').digest('hex');

function tmpStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ev-fix1-'));
  return createEvidenceStore({ dir, ...opts });
}

function passFields(over = {}) {
  return {
    fixSha: FIX,
    testedSha: FIX,
    command: 'node --test',
    exitCode: 0,
    passed: 3,
    failed: 0,
    outputHash: OUT,
    ...over,
  };
}

function writable(file) {
  try { fs.chmodSync(file, 0o644); } catch { /* ignore */ }
}

function promotionsDir(store) {
  return path.join(store.dir, 'promotions');
}

function headPath(store) {
  return path.join(promotionsDir(store), 'HEAD');
}

// --- ① promotion chain integrity ---

test('verifyPromotions passes a healthy chain', () => {
  const store = tmpStore();
  store.recordEvidence(passFields());
  promote(store, FIX, { approver: 'a1' });
  store.recordEvidence(passFields({ fixSha: FIX2, testedSha: FIX2, command: 'node --test b', outputHash: sha256Hex('b') }));
  promote(store, FIX2, { approver: 'a2' });
  const v = verifyPromotions(store);
  assert.equal(v.ok, true);
  assert.equal(v.problems.length, 0);
  assert.ok(v.head);
});

test('single-character edit of a promotion record is detected', () => {
  const store = tmpStore();
  store.recordEvidence(passFields());
  const { record } = promote(store, FIX, { approver: 'reviewer' });
  const file = path.join(promotionsDir(store), `${record.promotionId}.json`);
  writable(file);
  const raw = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, raw.replace('reviewer', 'attacker'));
  const v = verifyPromotions(store);
  assert.equal(v.ok, false);
  assert.ok(v.problems.length >= 1);
  assert.throws(() => evaluatePromotion(store, FIX), PromotionIntegrityError);
  assert.throws(() => promote(store, FIX, { approver: 'reviewer' }), (err) => (
    err instanceof PromotionIntegrityError || err instanceof TamperedEvidenceError
  ));
});

test('deleting the last promotion leaves HEAD mismatched', () => {
  const store = tmpStore();
  store.recordEvidence(passFields());
  const first = promote(store, FIX, { approver: 'a1' });
  store.recordEvidence(passFields({ fixSha: FIX2, testedSha: FIX2, command: 'node --test 2', outputHash: sha256Hex('2') }));
  const second = promote(store, FIX2, { approver: 'a2' });
  fs.unlinkSync(path.join(promotionsDir(store), `${second.record.promotionId}.json`));
  const v = verifyPromotions(store);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /HEAD|missing|chain/i.test(p)));
  void first;
});

test('deleting a middle promotion breaks the chain', () => {
  const store = tmpStore();
  const shas = [
    FIX,
    FIX2,
    'dddddddddddddddddddddddddddddddddddddddd',
  ];
  const ids = [];
  for (let i = 0; i < shas.length; i++) {
    const sha = shas[i];
    store.recordEvidence(passFields({
      fixSha: sha,
      testedSha: sha,
      command: `node --test ${i}`,
      outputHash: sha256Hex(`out-${i}`),
    }));
    ids.push(promote(store, sha, { approver: `a${i}` }).record.promotionId);
  }
  fs.unlinkSync(path.join(promotionsDir(store), `${ids[1]}.json`));
  const v = verifyPromotions(store);
  assert.equal(v.ok, false);
  assert.ok(v.problems.length >= 1);
});

test('referenced evidence tamper or delete fails verifyPromotions', () => {
  const store = tmpStore();
  const { evidenceId } = store.recordEvidence(passFields());
  promote(store, FIX, { approver: 'a1' });
  const evFile = path.join(store.dir, 'evidence', `${evidenceId}.json`);
  writable(evFile);
  const raw = fs.readFileSync(evFile, 'utf8');
  fs.writeFileSync(evFile, raw.replace('"passed":3', '"passed":9'));
  assert.equal(verifyPromotions(store).ok, false);

  const store2 = tmpStore();
  const saved = store2.recordEvidence(passFields({ command: 'node --test del' }));
  promote(store2, FIX, { approver: 'a1' });
  fs.unlinkSync(path.join(store2.dir, 'evidence', `${saved.evidenceId}.json`));
  assert.equal(verifyPromotions(store2).ok, false);
});

test('HEAD tamper is detected; expectedHead external anchor works', () => {
  const store = tmpStore();
  store.recordEvidence(passFields());
  const { record } = promote(store, FIX, { approver: 'a1' });
  const goodHead = record.promotionId;
  assert.equal(verifyPromotions(store, { expectedHead: goodHead }).ok, true);
  assert.equal(verifyPromotions(store, { expectedHead: 'f'.repeat(64) }).ok, false);

  writable(headPath(store));
  fs.writeFileSync(headPath(store), `${JSON.stringify({ head: '0'.repeat(64) })}\n`);
  assert.equal(verifyPromotions(store).ok, false);
});

test('HMAC seal forgery on promotion/HEAD is rejected', () => {
  const store = tmpStore({ hmacKey: 'chain-secret' });
  store.recordEvidence(passFields({ command: 'node --test seal' }));
  const { record } = promote(store, FIX, { approver: 'a1' });
  assert.ok(record.seal);
  const file = path.join(promotionsDir(store), `${record.promotionId}.json`);
  writable(file);
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  obj.seal = 'a'.repeat(64);
  fs.writeFileSync(file, `${JSON.stringify(obj)}\n`);
  assert.equal(verifyPromotions(store).ok, false);

  const store2 = tmpStore({ hmacKey: 'chain-secret' });
  store2.recordEvidence(passFields({ command: 'node --test headseal' }));
  promote(store2, FIX, { approver: 'a1' });
  writable(headPath(store2));
  const headObj = JSON.parse(fs.readFileSync(headPath(store2), 'utf8'));
  headObj.seal = 'b'.repeat(64);
  fs.writeFileSync(headPath(store2), `${JSON.stringify(headObj)}\n`);
  assert.equal(verifyPromotions(store2).ok, false);
});

test('re-promote after editing approver or evidenceIds is rejected', () => {
  const store = tmpStore();
  store.recordEvidence(passFields());
  const { record } = promote(store, FIX, { approver: 'honest' });
  const file = path.join(promotionsDir(store), `${record.promotionId}.json`);
  writable(file);

  const editedApprover = JSON.parse(fs.readFileSync(file, 'utf8'));
  editedApprover.approver = 'forged';
  // Keep promotionId so file name still matches lookup-by-id paths; content hash must fail.
  fs.writeFileSync(file, `${JSON.stringify(editedApprover)}\n`);
  assert.throws(() => promote(store, FIX, { approver: 'honest' }), (err) => (
    err instanceof TamperedEvidenceError || err instanceof PromotionIntegrityError
  ));

  const store2 = tmpStore();
  store2.recordEvidence(passFields({ command: 'node --test ids' }));
  const second = promote(store2, FIX, { approver: 'honest' });
  const file2 = path.join(promotionsDir(store2), `${second.record.promotionId}.json`);
  writable(file2);
  const editedIds = JSON.parse(fs.readFileSync(file2, 'utf8'));
  editedIds.evidenceIds = ['c'.repeat(64)];
  if (editedIds.evidenceDigests) {
    editedIds.evidenceDigests = [{ evidenceId: 'c'.repeat(64), contentHash: 'd'.repeat(64) }];
  }
  fs.writeFileSync(file2, `${JSON.stringify(editedIds)}\n`);
  assert.throws(() => promote(store2, FIX, { approver: 'honest' }), (err) => (
    err instanceof TamperedEvidenceError || err instanceof PromotionIntegrityError
  ));
});

// --- ② strict defaults to fail-closed ---

test('default evaluatePromotion refuses when failing evidence coexists with passing', () => {
  const store = tmpStore();
  store.recordEvidence(passFields({ command: 'fail', exitCode: 1, passed: 0, failed: 1, outputHash: sha256Hex('f') }));
  store.recordEvidence(passFields({ command: 'pass', outputHash: sha256Hex('p') }));
  const decision = evaluatePromotion(store, FIX);
  assert.equal(decision.promotable, false, 'strict defaults to true');
  assert.ok(decision.reasons.some((r) => /conflicting failing evidence/.test(r)));
});

test('explicit strict:false records mitigation and may promote', () => {
  const store = tmpStore();
  store.recordEvidence(passFields({ command: 'fail', exitCode: 1, passed: 0, failed: 1, outputHash: sha256Hex('f2') }));
  store.recordEvidence(passFields({ command: 'pass', outputHash: sha256Hex('p2') }));
  const decision = evaluatePromotion(store, FIX, { strict: false });
  assert.equal(decision.promotable, true);
  assert.ok(decision.reasons.some((r) => /strict:\s*false|mitigation|relaxed/i.test(r)));
});

// --- ③ CLI must not take raw --hmac-key values ---

test('CLI rejects --hmac-key value form and never echoes the secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cli-'));
  const cli = path.resolve('src/qa-evidence-cli.mjs');
  const secret = 'super-secret-cli-key-value';
  const r = spawnSync(process.execPath, [
    cli, 'check', '--dir', dir, '--fix', FIX, '--hmac-key', secret,
  ], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  const combined = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.match(combined, /hmac-key-env|hmac-key-file|not accepted|refused|use --hmac-key-env/i);
  assert.equal(combined.includes(secret), false, 'secret must not appear in output');
});

test('CLI accepts --hmac-key-env and --hmac-key-file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cli-ok-'));
  const outFile = path.join(dir, 'out.txt');
  fs.writeFileSync(outFile, 'hello');
  const cli = path.resolve('src/qa-evidence-cli.mjs');
  const envName = 'QA_EVIDENCE_TEST_HMAC';
  const secret = 'env-file-secret-xyz';
  const env = { ...process.env, [envName]: secret };
  const record = spawnSync(process.execPath, [
    cli, 'record',
    '--dir', dir,
    '--fix', FIX,
    '--tested', FIX,
    '--cmd', 'node --test',
    '--exit', '0',
    '--passed', '1',
    '--failed', '0',
    '--output-file', outFile,
    '--hmac-key-env', envName,
  ], { encoding: 'utf8', env });
  assert.equal(record.status, 0, record.stderr);
  assert.equal(`${record.stdout}${record.stderr}`.includes(secret), false);

  const keyFile = path.join(dir, 'key.txt');
  fs.writeFileSync(keyFile, secret, { mode: 0o600 });
  const check = spawnSync(process.execPath, [
    cli, 'check', '--dir', dir, '--fix', FIX, '--hmac-key-file', keyFile,
  ], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(`${check.stdout}${check.stderr}`.includes(secret), false);
});
