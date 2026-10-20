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
  const resolved = path.resolve(dir);
  return resolved;
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
  const strictDefault = options.strict === true;

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

  function promotionPath(fixSha) {
    const sha = normalizeSha(fixSha);
    const file = path.join(root, 'promotions', `${sha}.json`);
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
      return { evidenceId, created: true, record: readEvidenceFile(file, evidenceId) };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const existingRaw = fs.readFileSync(file, 'utf8');
      const existingParsed = parseEvidenceObject(existingRaw, evidenceId);
      if (canonicalJson(existingParsed.core) !== canonicalJson(core)) {
        throw new TamperedEvidenceError('evidenceId exists with different content');
      }
      const existing = readEvidenceFile(file, evidenceId);
      return { evidenceId, created: false, record: existing };
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
    return rec;
  }

  function listEvidence(fixShaFilter) {
    const want = fixShaFilter == null ? null : normalizeSha(fixShaFilter);
    const dir = path.join(root, 'evidence');
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    const out = [];
    for (const name of names) {
      const id = name.slice(0, -'.json'.length);
      if (!HASH64_RE.test(id)) continue;
      const rec = readEvidenceFile(path.join(dir, name), id);
      if (!rec) continue;
      if (want && rec.fixSha !== want) continue;
      out.push(rec);
    }
    return out;
  }

  return {
    dir: root,
    hmacEnabled: Boolean(hmacKey),
    strict: strictDefault,
    recordEvidence,
    getEvidence,
    listEvidence,
    evidencePath,
    promotionPath,
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
 * Decide whether fixSha may be promoted using only stored evidence.
 * @param {ReturnType<typeof createEvidenceStore>} store
 * @param {string} fixSha
 * @param {{ strict?: boolean }} [options]
 */
export function evaluatePromotion(store, fixSha, options = {}) {
  const sha = normalizeSha(fixSha);
  const strict = options.strict === true || store.strict === true;
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
  }

  return { promotable: true, reasons, evidenceIds: passingIds };
}

/**
 * Write an immutable promotion record when evaluatePromotion allows it.
 * Re-promoting the same fixSha is idempotent.
 */
export function promote(store, fixSha, { approver } = {}) {
  if (typeof approver !== 'string' || approver.trim() === '') {
    throw new InvalidEvidenceError('approver must be a non-empty string');
  }
  rejectNullBytes('approver', approver);
  if (approver.length > 256) throw new InvalidEvidenceError('approver exceeds 256 characters');

  const sha = normalizeSha(fixSha);
  const decision = evaluatePromotion(store, sha);
  if (!decision.promotable) {
    throw new PromotionRefusedError(
      `promotion refused for ${sha}: ${decision.reasons.join('; ') || 'not promotable'}`,
      decision.reasons,
    );
  }

  const file = store.promotionPath(sha);
  const record = {
    approver: approver.trim(),
    evidenceIds: [...decision.evidenceIds].sort(),
    fixSha: sha,
    promotedAt: new Date().toISOString(),
  };
  const text = `${canonicalJson(record)}\n`;

  try {
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
      // best-effort
    }
    return { created: true, record };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (existing.fixSha !== sha) {
      throw new TamperedEvidenceError('promotion file fixSha mismatch');
    }
    return { created: false, record: existing };
  }
}
