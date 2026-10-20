import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/;
const HASH64_RE = /^[0-9a-f]{64}$/;
const MAX_COMMAND = 4096;
const MAX_RUNNER = 256;

export class InvalidShaError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'InvalidShaError';
  }
}

export class InvalidEvidenceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'InvalidEvidenceError';
  }
}

export class TamperedEvidenceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TamperedEvidenceError';
  }
}

export class PromotionRefusedError extends Error {
  constructor(message, reasons = []) {
    super(message);
    this.name = 'PromotionRefusedError';
    this.reasons = reasons;
  }
}

export class PromotionIntegrityError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'PromotionIntegrityError';
    this.problems = problems;
  }
}

/** Accept only a full 40-char hex SHA; uppercase is normalized to lowercase. */
export function normalizeSha(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidShaError('SHA must be a non-empty string');
  }
  const sha = value.trim().toLowerCase();
  if (!SHA_RE.test(sha)) {
    throw new InvalidShaError('SHA must be a full 40-character lowercase hex digest');
  }
  return sha;
}

function rejectNullBytes(label, value) {
  if (typeof value === 'string' && value.includes('\0')) {
    throw new InvalidEvidenceError(`${label} must not contain null bytes`);
  }
}

function normalizeOutputHash(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidEvidenceError('outputHash must be a non-empty string');
  }
  const h = value.trim().toLowerCase();
  if (!HASH64_RE.test(h)) {
    throw new InvalidEvidenceError('outputHash must be a 64-character hex SHA-256 digest');
  }
  return h;
}

function assertNonNegInt(label, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidEvidenceError(`${label} must be a non-negative integer`);
  }
}

/** Deterministic JSON with recursively sorted object keys. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function corePayload(fields) {
  const core = {
    command: fields.command,
    exitCode: fields.exitCode,
    failed: fields.failed,
    fixSha: fields.fixSha,
    outputHash: fields.outputHash,
    passed: fields.passed,
    testedSha: fields.testedSha,
  };
  if (fields.runner != null && fields.runner !== '') core.runner = fields.runner;
  return core;
}

function evidenceIdFromCore(core) {
  return sha256Hex(canonicalJson(core));
}

function sealPayload(recordWithoutSeal, hmacKey) {
  return createHmac('sha256', hmacKey).update(canonicalJson(recordWithoutSeal)).digest('hex');
}

function resolveStoreDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new InvalidEvidenceError('dir must be a non-empty string');
  }
  rejectNullBytes('dir', dir);
  return path.resolve(dir);
}

function ensureInside(root, target) {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new InvalidEvidenceError('path escapes store directory');
  }
}

function validateCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new InvalidEvidenceError('command must be a non-empty string');
  }
  rejectNullBytes('command', command);
  if (command.length > MAX_COMMAND) {
    throw new InvalidEvidenceError(`command exceeds ${MAX_COMMAND} characters`);
  }
  return command;
}

function validateRunner(runner) {
  if (runner == null || runner === '') return undefined;
  if (typeof runner !== 'string') throw new InvalidEvidenceError('runner must be a string');
  rejectNullBytes('runner', runner);
  if (runner.length > MAX_RUNNER) {
    throw new InvalidEvidenceError(`runner exceeds ${MAX_RUNNER} characters`);
  }
  return runner;
}

function parseEvidenceObject(raw, expectedId) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (cause) {
    throw new TamperedEvidenceError('evidence file is not valid JSON', { cause });
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new TamperedEvidenceError('evidence file must contain a JSON object');
  }
  const core = corePayload({
    fixSha: normalizeSha(obj.fixSha),
    testedSha: normalizeSha(obj.testedSha),
    command: validateCommand(obj.command),
    exitCode: obj.exitCode,
    passed: obj.passed,
    failed: obj.failed,
    outputHash: normalizeOutputHash(obj.outputHash),
    runner: obj.runner,
  });
  assertNonNegInt('passed', core.passed);
  assertNonNegInt('failed', core.failed);
  if (typeof core.exitCode !== 'number' || !Number.isInteger(core.exitCode)) {
    throw new InvalidEvidenceError('exitCode must be an integer');
  }
  const id = evidenceIdFromCore(core);
  if (expectedId && id !== expectedId) {
    throw new TamperedEvidenceError('evidence content hash does not match evidenceId');
  }
  if (obj.evidenceId != null && obj.evidenceId !== id) {
    throw new TamperedEvidenceError('embedded evidenceId does not match content hash');
  }
  return { core, id, obj };
}

function promotionCoreForId(fields) {
  return {
    approver: fields.approver,
    evidenceDigests: fields.evidenceDigests,
    evidenceIds: fields.evidenceIds,
    fixSha: fields.fixSha,
    prevPromotionId: fields.prevPromotionId,
    promotedAt: fields.promotedAt,
  };
}

function promotionIdFromCore(core) {
  return sha256Hex(canonicalJson(core));
}

function resolveStrict(store, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'strict')) return Boolean(options.strict);
  return store.strict !== false;
}

/**
 * Create a filesystem-backed immutable QA evidence store.
 * @param {{ dir: string, hmacKey?: string|Buffer, strict?: boolean }} options
 */
export function createEvidenceStore(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('options object required');
  }
  const root = resolveStoreDir(options.dir);
  const hmacKey = options.hmacKey == null || options.hmacKey === ''
    ? null
    : Buffer.isBuffer(options.hmacKey)
      ? options.hmacKey
      : Buffer.from(String(options.hmacKey), 'utf8');
  // Fail-closed by default: conflicting failing evidence refuses promotion unless strict:false.
  const strictDefault = options.strict !== false;

  fs.mkdirSync(path.join(root, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(root, 'promotions'), { recursive: true });

  function evidencePath(evidenceId) {
    if (!HASH64_RE.test(evidenceId)) {
      throw new InvalidEvidenceError('evidenceId must be a 64-character hex digest');
    }
    const file = path.join(root, 'evidence', `${evidenceId}.json`);
    ensureInside(root, file);
    return file;
  }

  function promotionPath(promotionId) {
    if (!HASH64_RE.test(promotionId)) {
      throw new InvalidEvidenceError('promotionId must be a 64-character hex digest');
    }
    const file = path.join(root, 'promotions', `${promotionId}.json`);
    ensureInside(root, file);
    return file;
  }

  function headFilePath() {
    const file = path.join(root, 'promotions', 'HEAD');
    ensureInside(root, file);
    return file;
  }

  function readEvidenceFile(file, evidenceId) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
    const { core, id, obj } = parseEvidenceObject(raw, evidenceId);
    if (hmacKey) {
      if (typeof obj.seal !== 'string' || !HASH64_RE.test(obj.seal)) {
        throw new TamperedEvidenceError('missing or invalid HMAC seal');
      }
      const material = {
        command: core.command,
        evidenceId: id,
        exitCode: core.exitCode,
        failed: core.failed,
        fixSha: core.fixSha,
        outputHash: core.outputHash,
        passed: core.passed,
        recordedAt: obj.recordedAt,
        testedSha: core.testedSha,
      };
      if (core.runner != null) material.runner = core.runner;
      const want = sealPayload(material, hmacKey);
      if (obj.seal !== want) {
        throw new TamperedEvidenceError('HMAC seal verification failed');
      }
    }
    return {
      evidenceId: id,
      fixSha: core.fixSha,
      testedSha: core.testedSha,
      command: core.command,
      exitCode: core.exitCode,
      passed: core.passed,
      failed: core.failed,
      outputHash: core.outputHash,
      runner: core.runner,
      recordedAt: obj.recordedAt,
      seal: obj.seal,
      _raw: raw,
      _contentHash: sha256Hex(raw),
    };
  }

  function writeExclusive(file, text) {
    ensureInside(root, file);
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(file, 0o444);
    } catch {
      // Best-effort read-only; some platforms may ignore.
    }
  }

  function writeReplace(file, text) {
    ensureInside(root, file);
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, file);
    } catch {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      fs.renameSync(tmp, file);
    }
  }

  function readHead() {
    const file = headFilePath();
    if (!fs.existsSync(file)) return { head: null, seal: undefined };
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (cause) {
      throw new PromotionIntegrityError('HEAD file is not valid JSON', ['HEAD is not valid JSON']);
    }
    if (!obj || typeof obj !== 'object' || (obj.head != null && !HASH64_RE.test(obj.head))) {
      throw new PromotionIntegrityError('HEAD file is malformed', ['HEAD is malformed']);
    }
    if (hmacKey) {
      if (typeof obj.seal !== 'string' || !HASH64_RE.test(obj.seal)) {
        throw new PromotionIntegrityError('HEAD seal missing or invalid', ['HEAD seal missing or invalid']);
      }
      const want = sealPayload({ head: obj.head }, hmacKey);
      if (obj.seal !== want) {
        throw new PromotionIntegrityError('HEAD seal verification failed', ['HEAD seal verification failed']);
      }
    }
    return { head: obj.head ?? null, seal: obj.seal };
  }

  function writeHead(headId) {
    const obj = { head: headId };
    if (hmacKey) obj.seal = sealPayload({ head: headId }, hmacKey);
    writeReplace(headFilePath(), `${canonicalJson(obj)}\n`);
  }

  function parsePromotionRecord(raw, expectedId) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (cause) {
      throw new TamperedEvidenceError('promotion file is not valid JSON', { cause });
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new TamperedEvidenceError('promotion file must contain a JSON object');
    }
    if (!Array.isArray(obj.evidenceIds) || !Array.isArray(obj.evidenceDigests)) {
      throw new TamperedEvidenceError('promotion record missing evidenceIds/evidenceDigests');
    }
    const core = promotionCoreForId({
      approver: obj.approver,
      evidenceDigests: obj.evidenceDigests,
      evidenceIds: obj.evidenceIds,
      fixSha: normalizeSha(obj.fixSha),
      prevPromotionId: obj.prevPromotionId == null ? null : obj.prevPromotionId,
      promotedAt: obj.promotedAt,
    });
    if (core.prevPromotionId != null && !HASH64_RE.test(core.prevPromotionId)) {
      throw new TamperedEvidenceError('prevPromotionId is invalid');
    }
    const id = promotionIdFromCore(core);
    if (expectedId && id !== expectedId) {
      throw new TamperedEvidenceError('promotion content hash does not match promotionId');
    }
    if (obj.promotionId != null && obj.promotionId !== id) {
      throw new TamperedEvidenceError('embedded promotionId does not match content hash');
    }
    if (hmacKey) {
      if (typeof obj.seal !== 'string' || !HASH64_RE.test(obj.seal)) {
        throw new TamperedEvidenceError('promotion seal missing or invalid');
      }
      const material = { ...core, promotionId: id };
      const want = sealPayload(material, hmacKey);
      if (obj.seal !== want) {
        throw new TamperedEvidenceError('promotion seal verification failed');
      }
    }
    return {
      promotionId: id,
      approver: core.approver,
      evidenceDigests: core.evidenceDigests,
      evidenceIds: core.evidenceIds,
      fixSha: core.fixSha,
      prevPromotionId: core.prevPromotionId,
      promotedAt: core.promotedAt,
      seal: obj.seal,
    };
  }

  function readPromotionFile(promotionId) {
    const file = promotionPath(promotionId);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
    return parsePromotionRecord(raw, promotionId);
  }

  /**
   * Persist one evidence record. Identical content is idempotent (same evidenceId, no extra file).
   * @returns {{ evidenceId: string, created: boolean, record: object }}
   */
  function recordEvidence(input) {
    if (!input || typeof input !== 'object') throw new TypeError('evidence fields required');
    const fixSha = normalizeSha(input.fixSha);
    const testedSha = normalizeSha(input.testedSha);
    const command = validateCommand(input.command);
    if (typeof input.exitCode !== 'number' || !Number.isInteger(input.exitCode)) {
      throw new InvalidEvidenceError('exitCode must be an integer');
    }
    assertNonNegInt('passed', input.passed);
    assertNonNegInt('failed', input.failed);
    const outputHash = normalizeOutputHash(input.outputHash);
    const runner = validateRunner(input.runner);

    const core = corePayload({
      fixSha,
      testedSha,
      command,
      exitCode: input.exitCode,
      passed: input.passed,
      failed: input.failed,
      outputHash,
      runner,
    });
    const evidenceId = evidenceIdFromCore(core);
    const file = evidencePath(evidenceId);
    const recordedAt = typeof input.recordedAt === 'string' && input.recordedAt
      ? input.recordedAt
      : new Date().toISOString();
    rejectNullBytes('recordedAt', recordedAt);

    const record = {
      command: core.command,
      evidenceId,
      exitCode: core.exitCode,
      failed: core.failed,
      fixSha: core.fixSha,
      outputHash: core.outputHash,
      passed: core.passed,
      recordedAt,
      testedSha: core.testedSha,
    };
    if (core.runner != null) record.runner = core.runner;
    if (hmacKey) {
      record.seal = sealPayload(record, hmacKey);
    }

    const text = `${canonicalJson(record)}\n`;

    try {
      writeExclusive(file, text);
      const saved = readEvidenceFile(file, evidenceId);
      const { _raw, _contentHash, ...publicRec } = saved;
      void _raw;
      void _contentHash;
      return { evidenceId, created: true, record: publicRec };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const existingRaw = fs.readFileSync(file, 'utf8');
      const existingParsed = parseEvidenceObject(existingRaw, evidenceId);
      if (canonicalJson(existingParsed.core) !== canonicalJson(core)) {
        throw new TamperedEvidenceError('evidenceId exists with different content');
      }
      const existing = readEvidenceFile(file, evidenceId);
      const { _raw, _contentHash, ...publicRec } = existing;
      void _raw;
      void _contentHash;
      return { evidenceId, created: false, record: publicRec };
    }
  }

  function getEvidence(evidenceId) {
    if (!HASH64_RE.test(String(evidenceId || '').toLowerCase())) {
      throw new InvalidEvidenceError('evidenceId must be a 64-character hex digest');
    }
    const id = String(evidenceId).toLowerCase();
    const file = evidencePath(id);
    const rec = readEvidenceFile(file, id);
    if (!rec) throw new InvalidEvidenceError(`unknown evidenceId ${id}`);
    const { _raw, _contentHash, ...publicRec } = rec;
    void _raw;
    void _contentHash;
    return publicRec;
  }

  function listEvidence(fixShaFilter) {
    const want = fixShaFilter == null ? null : normalizeSha(fixShaFilter);
    const dir = path.join(root, 'evidence');
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    const out = [];
    for (const name of names) {
      const id = name.slice(0, -'.json'.length);
      if (!HASH64_RE.test(id)) continue;
      // Fail-closed: a single tampered evidence file aborts listing for the whole store.
      const rec = readEvidenceFile(path.join(dir, name), id);
      if (!rec) continue;
      if (want && rec.fixSha !== want) continue;
      const { _raw, _contentHash, ...publicRec } = rec;
      void _raw;
      void _contentHash;
      out.push(publicRec);
    }
    return out;
  }

  function buildEvidenceDigests(evidenceIds) {
    const digests = [];
    for (const id of evidenceIds) {
      const file = evidencePath(id);
      const raw = fs.readFileSync(file);
      digests.push({ evidenceId: id, contentHash: sha256Hex(raw) });
    }
    digests.sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0));
    return digests;
  }

  return {
    dir: root,
    hmacEnabled: Boolean(hmacKey),
    hmacKey,
    strict: strictDefault,
    recordEvidence,
    getEvidence,
    listEvidence,
    evidencePath,
    promotionPath,
    headFilePath,
    readHead,
    writeHead,
    readPromotionFile,
    parsePromotionRecord,
    buildEvidenceDigests,
    writeExclusive,
    writeReplace,
    readEvidenceFile,
  };
}

function isPassingEvidence(rec, fixSha) {
  const reasons = [];
  if (rec.testedSha !== fixSha) {
    reasons.push(`testedSha mismatch: evidence tested ${rec.testedSha}, required ${fixSha}`);
  }
  if (rec.exitCode !== 0) reasons.push(`exitCode ${rec.exitCode} is not 0`);
  if (rec.failed !== 0) reasons.push(`failed count ${rec.failed} is not 0`);
  if (!(rec.passed >= 1)) reasons.push('passed must be >= 1');
  try {
    validateCommand(rec.command);
  } catch {
    reasons.push('command is invalid');
  }
  try {
    normalizeOutputHash(rec.outputHash);
  } catch {
    reasons.push('outputHash is invalid');
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Walk the promotion hash chain and validate links, seals, and referenced evidence.
 * @param {ReturnType<typeof createEvidenceStore>} store
 * @param {{ expectedHead?: string|null }} [options]
 */
export function verifyPromotions(store, options = {}) {
  const problems = [];
  let headMeta;
  try {
    headMeta = store.readHead();
  } catch (err) {
    if (err instanceof PromotionIntegrityError) {
      return { ok: false, problems: err.problems, head: null };
    }
    throw err;
  }

  const head = headMeta.head;
  if (Object.prototype.hasOwnProperty.call(options, 'expectedHead')) {
    const expected = options.expectedHead == null ? null : String(options.expectedHead).toLowerCase();
    if (expected !== head) {
      problems.push(`HEAD does not match expectedHead (have ${head}, expected ${expected})`);
    }
  }

  if (head == null) {
    return { ok: problems.length === 0, problems, head: null };
  }

  let currentId = head;
  const seen = new Set();
  let last = null;
  while (currentId != null) {
    if (seen.has(currentId)) {
      problems.push(`cycle detected at ${currentId}`);
      break;
    }
    seen.add(currentId);
    let rec;
    try {
      rec = store.readPromotionFile(currentId);
    } catch (err) {
      problems.push(`promotion ${currentId}: ${err.message}`);
      break;
    }
    if (!rec) {
      problems.push(`missing promotion file for chain id ${currentId} (HEAD/chain mismatch)`);
      break;
    }
    last = rec;
    for (const digest of rec.evidenceDigests) {
      if (!digest || !HASH64_RE.test(digest.evidenceId) || !HASH64_RE.test(digest.contentHash)) {
        problems.push(`promotion ${currentId}: malformed evidence digest`);
        continue;
      }
      const file = store.evidencePath(digest.evidenceId);
      let raw;
      try {
        raw = fs.readFileSync(file);
      } catch {
        problems.push(`promotion ${currentId}: missing evidence ${digest.evidenceId}`);
        continue;
      }
      try {
        store.readEvidenceFile(file, digest.evidenceId);
      } catch (err) {
        problems.push(`promotion ${currentId}: evidence ${digest.evidenceId} invalid (${err.message})`);
        continue;
      }
      const hash = sha256Hex(raw);
      if (hash !== digest.contentHash) {
        problems.push(`promotion ${currentId}: evidence ${digest.evidenceId} content hash mismatch`);
      }
    }
    const sortedIds = [...rec.evidenceIds].sort();
    const digestIds = rec.evidenceDigests.map((d) => d.evidenceId).sort();
    if (canonicalJson(sortedIds) !== canonicalJson(digestIds)) {
      problems.push(`promotion ${currentId}: evidenceIds do not match evidenceDigests`);
    }
    currentId = rec.prevPromotionId;
  }

  if (head && last && last.promotionId !== head && problems.length === 0) {
    // head is the tip; last after walk is the genesis. Ensure tip file matched head (already).
  }

  return { ok: problems.length === 0, problems, head };
}

function assertPromotionIntegrity(store, options) {
  const v = verifyPromotions(store, options);
  if (!v.ok) {
    throw new PromotionIntegrityError(
      `promotion chain integrity check failed: ${v.problems.join('; ')}`,
      v.problems,
    );
  }
  return v;
}

function findPromotionForFixSha(store, fixSha) {
  const head = store.readHead().head;
  let currentId = head;
  while (currentId != null) {
    const rec = store.readPromotionFile(currentId);
    if (!rec) throw new PromotionIntegrityError(`missing promotion ${currentId}`, [`missing promotion ${currentId}`]);
    if (rec.fixSha === fixSha) return rec;
    currentId = rec.prevPromotionId;
  }
  return null;
}

/**
 * Decide whether fixSha may be promoted using only stored evidence.
 * Refuses with PromotionIntegrityError when the promotion chain is broken.
 */
export function evaluatePromotion(store, fixSha, options = {}) {
  assertPromotionIntegrity(store);
  const sha = normalizeSha(fixSha);
  const strict = resolveStrict(store, options);
  const all = store.listEvidence(sha);
  const reasons = [];
  const evidenceIds = [];
  const passingIds = [];
  let failingPresent = false;

  if (all.length === 0) {
    reasons.push('no evidence recorded for fixSha');
    return { promotable: false, reasons, evidenceIds };
  }

  for (const rec of all) {
    evidenceIds.push(rec.evidenceId);
    const { ok, reasons: local } = isPassingEvidence(rec, sha);
    if (ok) {
      passingIds.push(rec.evidenceId);
    } else {
      reasons.push(...local.map((r) => `${rec.evidenceId}: ${r}`));
      if (rec.failed > 0 || rec.exitCode !== 0) failingPresent = true;
    }
  }

  if (passingIds.length === 0) {
    if (!reasons.length) reasons.push('no passing evidence');
    return { promotable: false, reasons, evidenceIds };
  }

  if (failingPresent) {
    reasons.push('conflicting failing evidence exists for the same fixSha');
    if (strict) {
      return { promotable: false, reasons, evidenceIds };
    }
    reasons.push('strict:false mitigation in effect; a single accidental pass may allow promotion');
  }

  return { promotable: true, reasons, evidenceIds: [...passingIds].sort() };
}

/**
 * Append an immutable promotion record to the hash chain when evaluation allows it.
 * Re-promoting the same fixSha re-checks stored evidenceIds against a fresh evaluation.
 */
export function promote(store, fixSha, { approver } = {}) {
  if (typeof approver !== 'string' || approver.trim() === '') {
    throw new InvalidEvidenceError('approver must be a non-empty string');
  }
  rejectNullBytes('approver', approver);
  if (approver.length > 256) throw new InvalidEvidenceError('approver exceeds 256 characters');

  assertPromotionIntegrity(store);

  const sha = normalizeSha(fixSha);
  const decision = evaluatePromotion(store, sha);
  if (!decision.promotable) {
    throw new PromotionRefusedError(
      `promotion refused for ${sha}: ${decision.reasons.join('; ') || 'not promotable'}`,
      decision.reasons,
    );
  }

  const existing = findPromotionForFixSha(store, sha);
  if (existing) {
    // Re-read from disk to detect edits; content hash / seal must still match.
    const fresh = store.readPromotionFile(existing.promotionId);
    if (!fresh) {
      throw new PromotionIntegrityError(`missing promotion ${existing.promotionId}`, [`missing promotion ${existing.promotionId}`]);
    }
    const wantIds = [...decision.evidenceIds].sort();
    const haveIds = [...fresh.evidenceIds].sort();
    if (canonicalJson(wantIds) !== canonicalJson(haveIds)) {
      throw new TamperedEvidenceError('stored promotion evidenceIds do not match current evaluation');
    }
    // Detect approver / digest edits even when ids coincide.
    const digests = store.buildEvidenceDigests(haveIds);
    if (canonicalJson(digests) !== canonicalJson(fresh.evidenceDigests)) {
      throw new TamperedEvidenceError('stored promotion evidenceDigests do not match evidence files');
    }
    return { created: false, record: fresh };
  }

  const prevPromotionId = store.readHead().head;
  const evidenceIds = [...decision.evidenceIds].sort();
  const evidenceDigests = store.buildEvidenceDigests(evidenceIds);
  const promotedAt = new Date().toISOString();
  const core = promotionCoreForId({
    approver: approver.trim(),
    evidenceDigests,
    evidenceIds,
    fixSha: sha,
    prevPromotionId,
    promotedAt,
  });
  const promotionId = promotionIdFromCore(core);
  const record = { ...core, promotionId };
  if (store.hmacEnabled) {
    record.seal = sealPayload({ ...core, promotionId }, store.hmacKey);
  }
  const text = `${canonicalJson(record)}\n`;
  store.writeExclusive(store.promotionPath(promotionId), text);
  store.writeHead(promotionId);
  return { created: true, record: store.readPromotionFile(promotionId) };
}
