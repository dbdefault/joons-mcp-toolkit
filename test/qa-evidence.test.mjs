import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createEvidenceStore,
  evaluatePromotion,
  promote,
  normalizeSha,
  canonicalJson,
  sha256Hex,
  InvalidShaError,
  InvalidEvidenceError,
  TamperedEvidenceError,
  PromotionRefusedError,
} from '../src/qa-evidence.mjs';

const FIX = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OUT = createHash('sha256').update('sample-output').digest('hex');

function tmpStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ev-'));
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

test('rejects short, empty, and non-hex SHA values', () => {
  assert.throws(() => normalizeSha(''), InvalidShaError);
  assert.throws(() => normalizeSha('abc'), InvalidShaError);
  assert.throws(() => normalizeSha('g'.repeat(40)), InvalidShaError);
  assert.equal(normalizeSha('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('canonical JSON is key-order independent', () => {
  const a = canonicalJson({ z: 1, a: { c: 3, b: 2 } });
  const b = canonicalJson({ a: { b: 2, c: 3 }, z: 1 });
  assert.equal(a, b);
  assert.equal(sha256Hex(a), sha256Hex(b));
});

test('mismatched testedSha cannot promote (with reasons)', () => {
  const store = tmpStore();
  store.recordEvidence(passFields({ testedSha: OTHER }));
  const decision = evaluatePromotion(store, FIX);
  assert.equal(decision.promotable, false);
  assert.ok(decision.reasons.some((r) => /testedSha mismatch/.test(r)));
  // MUTATION_CHECK: if promotable were asserted true here, the suite would hide SHA binding bugs.
  console.log('MUTATION_CHECK: testedSha mismatch stays non-promotable; inverting this assert would greenwash wrong SHA reuse');
  assert.throws(() => promote(store, FIX, { approver: 'qa-bot' }), PromotionRefusedError);
  assert.equal(fs.readdirSync(path.join(store.dir, 'promotions')).length, 0);
});

test('PASS evidence for another commit is never reused for this fixSha', () => {
  const store = tmpStore();
  store.recordEvidence(passFields({ fixSha: OTHER, testedSha: OTHER }));
  const decision = evaluatePromotion(store, FIX);
  assert.equal(decision.promotable, false);
  assert.ok(decision.reasons.some((r) => /no evidence/.test(r)));
});

test('failing evidence alone is not promotable; default strict keeps mixed results refused', () => {
  const store = tmpStore();
  store.recordEvidence(passFields({ command: 'node --test fail', exitCode: 1, passed: 0, failed: 2, outputHash: sha256Hex('fail') }));
  let decision = evaluatePromotion(store, FIX);
  assert.equal(decision.promotable, false);

  store.recordEvidence(passFields({ command: 'node --test pass', outputHash: sha256Hex('pass') }));
  // Default is fail-closed (strict:true). Explicit relaxation is covered in fix1 tests.
  decision = evaluatePromotion(store, FIX);
  assert.equal(decision.promotable, false);
  assert.ok(decision.reasons.some((r) => /conflicting failing evidence/.test(r)));
});

test('exitCode !== 0 is not promotable', () => {
  const store = tmpStore();
  store.recordEvidence(passFields({ exitCode: 2, failed: 0, passed: 1 }));
  assert.equal(evaluatePromotion(store, FIX).promotable, false);
});

test('store constructed with strict:true still refuses mixed pass/fail evidence', () => {
  const store = tmpStore({ strict: true });
  store.recordEvidence(passFields({ command: 'fail', exitCode: 1, passed: 0, failed: 1, outputHash: sha256Hex('f') }));
  store.recordEvidence(passFields({ command: 'pass', outputHash: sha256Hex('p') }));
  const decision = evaluatePromotion(store, FIX);
  assert.equal(decision.promotable, false);
  assert.ok(decision.reasons.some((r) => /conflicting failing evidence/.test(r)));
});

test('single-character tamper is detected on read', () => {
  const store = tmpStore();
  const { evidenceId } = store.recordEvidence(passFields());
  const file = path.join(store.dir, 'evidence', `${evidenceId}.json`);
  fs.chmodSync(file, 0o644);
  const raw = fs.readFileSync(file, 'utf8');
  const tweaked = raw.replace('"passed":3', '"passed":4');
  assert.notEqual(tweaked, raw);
  fs.writeFileSync(file, tweaked);
  assert.throws(() => store.getEvidence(evidenceId), TamperedEvidenceError);
  // MUTATION_CHECK: reading without hash check would accept this corrupted file.
  console.log('MUTATION_CHECK: one-character edit must throw TamperedEvidenceError; skipping the throw would accept forgery');
});

test('identical evidence is idempotent and concurrent writes create one file', async () => {
  const store = tmpStore();
  const fields = passFields({ recordedAt: '2020-01-01T00:00:00.000Z' });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => Promise.resolve().then(() => store.recordEvidence(fields))),
  );
  const ids = new Set(results.map((r) => r.evidenceId));
  assert.equal(ids.size, 1);
  const files = fs.readdirSync(path.join(store.dir, 'evidence')).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
});

test('HMAC: unsigned or wrong-key records are rejected; correct key passes', () => {
  const unsigned = tmpStore();
  const { evidenceId } = unsigned.recordEvidence(passFields());
  const sealed = tmpStore({ hmacKey: 'correct-secret' });
  // Copy unsigned file into sealed store path → missing seal.
  const src = path.join(unsigned.dir, 'evidence', `${evidenceId}.json`);
  const dest = path.join(sealed.dir, 'evidence', `${evidenceId}.json`);
  fs.copyFileSync(src, dest);
  assert.throws(() => sealed.getEvidence(evidenceId), TamperedEvidenceError);

  const good = tmpStore({ hmacKey: 'correct-secret' });
  const saved = good.recordEvidence(passFields({ command: 'node --test hmac' }));
  assert.ok(saved.record.seal);
  assert.equal(good.getEvidence(saved.evidenceId).evidenceId, saved.evidenceId);

  const wrong = createEvidenceStore({ dir: good.dir, hmacKey: 'other-secret' });
  assert.throws(() => wrong.getEvidence(saved.evidenceId), TamperedEvidenceError);
});

test('promotion writes immutable chain record, is idempotent, and refuses without files', () => {
  const store = tmpStore();
  store.recordEvidence(passFields());
  const first = promote(store, FIX, { approver: 'reviewer-1' });
  assert.equal(first.created, true);
  assert.ok(first.record.promotionId);
  assert.equal(first.record.prevPromotionId, null);
  const second = promote(store, FIX, { approver: 'reviewer-2' });
  assert.equal(second.created, false);
  assert.equal(second.record.approver, 'reviewer-1');
  const names = fs.readdirSync(path.join(store.dir, 'promotions')).filter((n) => n.endsWith('.json'));
  assert.equal(names.length, 1);
  assert.ok(fs.existsSync(path.join(store.dir, 'promotions', 'HEAD')));

  const empty = tmpStore();
  assert.throws(() => promote(empty, FIX, { approver: 'x' }), PromotionRefusedError);
  assert.equal(fs.readdirSync(path.join(empty.dir, 'promotions')).filter((n) => n.endsWith('.json')).length, 0);
});

test('path escape attempts are rejected', () => {
  const store = tmpStore();
  assert.throws(() => store.getEvidence('../' + 'a'.repeat(62)), InvalidEvidenceError);
  assert.throws(
    () => store.recordEvidence(passFields({ command: 'x'.repeat(5000) })),
    InvalidEvidenceError,
  );
  assert.throws(
    () => store.recordEvidence(passFields({ command: 'node\0--test' })),
    InvalidEvidenceError,
  );
});

test('null / invalid field types are rejected', () => {
  const store = tmpStore();
  assert.throws(() => store.recordEvidence(passFields({ passed: -1 })), InvalidEvidenceError);
  assert.throws(() => store.recordEvidence(passFields({ exitCode: 1.5 })), InvalidEvidenceError);
  assert.throws(() => store.recordEvidence(passFields({ outputHash: 'short' })), InvalidEvidenceError);
});
