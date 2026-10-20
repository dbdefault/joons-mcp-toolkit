# QA evidence store

Immutable, content-addressed records that bind automated test results to an exact Git commit SHA. Promotion (release / PR-ready) decisions are derived only from those records and a hash-linked promotion chain.

한국어 요약: 이 모듈은 “수정 커밋에 대한 독립 QA 증거”를 파일로 남기고, 승격 가능 여부를 증거와 승격 해시 체인만으로 판정합니다. 짧은 SHA·다른 커밋의 PASS 재사용·변조된 파일은 거부합니다. 기본 정책은 fail-closed(`strict: true`)입니다. HMAC 키 없이도 내용 해시로 변조는 탐지하지만, 키 없이 파일 집합을 통째로 다시 쓰는 공격자는 막지 못합니다. 그런 경우 `verifyPromotions({ expectedHead })`로 외부에 보관한 HEAD 앵커와 대조하세요.

## Why

A green test log that does not name the revision under test is not sufficient to promote that revision. This module stores:

- `fixSha` — the commit proposed for promotion
- `testedSha` — the commit the tests actually ran against
- command, exit code, pass/fail counts, and a SHA-256 of the captured output

Promotion is allowed only when at least one evidence record proves a successful run against the **same** full SHA, and (by default) no conflicting failing evidence exists for that SHA.

## API sketch

```js
import {
  createEvidenceStore,
  evaluatePromotion,
  promote,
  verifyPromotions,
} from '../src/qa-evidence.mjs';

const store = createEvidenceStore({ dir: './qa-store', hmacKey: process.env.QA_HMAC_KEY });
store.recordEvidence({
  fixSha: '<40-hex>',
  testedSha: '<40-hex>',
  command: 'node --test',
  exitCode: 0,
  passed: 12,
  failed: 0,
  outputHash: '<64-hex>',
});
const decision = evaluatePromotion(store, fixSha); // strict defaults to true
if (decision.promotable) promote(store, fixSha, { approver: 'ci-bot' });
const chain = verifyPromotions(store, { expectedHead: process.env.QA_PROMOTION_HEAD });
```

CLI:

```bash
export QA_HMAC_KEY='...'   # optional
node src/qa-evidence-cli.mjs record --dir ./qa-store --fix <sha> --tested <sha> \
  --cmd "node --test" --exit 0 --passed 12 --failed 0 --output-file ./out.txt \
  --hmac-key-env QA_HMAC_KEY
node src/qa-evidence-cli.mjs check --dir ./qa-store --fix <sha> --hmac-key-file ./hmac.key
```

`--hmac-key <value>` is rejected. Pass secrets only via `--hmac-key-env` or `--hmac-key-file`.

## SHA rules

- Only full 40-character hexadecimal SHAs are accepted.
- Uppercase digits are normalized to lowercase.
- Short SHAs, empty values, and non-hex strings are rejected.

## Storage layout

```text
<dir>/evidence/<evidenceId>.json        # exclusive create (wx), fsync, best-effort chmod a-w
<dir>/promotions/<promotionId>.json     # immutable promotion records (hash chain)
<dir>/promotions/HEAD                   # tip promotionId (+ optional HMAC seal)
```

`evidenceId` is the SHA-256 of the canonical JSON of the semantic fields (sorted keys), excluding `recordedAt` and `seal`. Re-recording identical semantic content returns the same id and does not grow the file set. Concurrent identical writes still leave a single file.

If a file already exists for an `evidenceId` but the semantic content differs, the store raises `TamperedEvidenceError`.

Each promotion record includes:

- `prevPromotionId` — previous tip (`null` for the first record)
- `evidenceIds` — ids that justified the promotion
- `evidenceDigests` — `{ evidenceId, contentHash }` for each referenced evidence file body
- optional `seal` when `hmacKey` is configured

`promotionId` is the SHA-256 of the canonical promotion fields (excluding `seal`).

## Promotion rules

`evaluatePromotion(store, fixSha)` returns `{ promotable, reasons, evidenceIds }`.

A record counts as passing only when all of the following hold:

1. `testedSha === fixSha` (exact match; another commit’s PASS never applies)
2. `exitCode === 0`
3. `failed === 0`
4. `passed >= 1`
5. `command` and `outputHash` are well-formed

### Fail-closed default (`strict`)

- **Default:** `strict: true` (store default and evaluate default).
- If any failing/conflicting evidence exists for the same `fixSha` (`failed > 0`, `exitCode !== 0`, or otherwise non-passing alongside a pass), promotion is **refused**.
- Relaxation requires an explicit `{ strict: false }` (or constructing the store with `strict: false`). Reasons then record that mitigation is in effect.
- Security meaning: with `strict: false`, a single accidental or flaky PASS can make `promotable: true` even when failing runs for the same SHA are on disk. Prefer keeping the default.

`promote` refuses with `PromotionRefusedError` when evaluation fails. Re-promoting the same `fixSha` is idempotent only when the stored `evidenceIds` still match a fresh evaluation and the on-disk record has not been edited; otherwise `TamperedEvidenceError` / `PromotionIntegrityError` is raised. No promotion file is created on refusal.

`verifyPromotions(store, { expectedHead? })` walks the chain from `HEAD`, checks each record hash/seal, `prevPromotionId` links, referenced evidence existence and content hashes, and optional external `expectedHead`. `evaluatePromotion` / `promote` call this first and throw `PromotionIntegrityError` when the chain is broken (further promotions are blocked until repaired).

## Corrupted evidence and availability (fail-closed)

`listEvidence` scans every file under `<dir>/evidence` and verifies each one before filtering by `fixSha`. Therefore **one tampered or unreadable evidence file blocks evaluation for the entire store** (all `fixSha` values), not only the SHA named in that file. This is intentional fail-closed behavior: a partial, silently skipped corrupt set could hide conflicting results.

Recovery:

1. Quarantine the offending file (move it out of `<dir>/evidence`).
2. Re-record legitimate evidence if needed (`recordEvidence` / CLI `record`).
3. Re-run `verifyPromotions` and `evaluatePromotion`.

Do not “fix” a JSON body in place while keeping the old `evidenceId` filename; content-addressing will reject the mismatch. Write a new record instead.

## Threat model

### Mitigations

| Threat | Handling |
|---|---|
| Accidental reuse of another commit’s PASS | `testedSha` must equal `fixSha` |
| Short / ambiguous SHA | Rejected at ingest |
| Bit-flip or hand-edit of a stored evidence JSON file | Content hash must equal `evidenceId` on every read |
| Duplicate concurrent inserts of the same result | Exclusive create + content-addressed id → one file |
| Unsigned records when an HMAC key is configured | Missing/invalid `seal` → `TamperedEvidenceError` |
| Wrong HMAC key | Seal verification fails |
| Promotion record tampering (approver / evidenceIds / body) | `promotionId` content hash, optional seal, re-evaluate on idempotent `promote`, `verifyPromotions` |
| Broken or truncated promotion chain | `HEAD` / `prevPromotionId` walk; missing tip or middle link fails verify |
| CLI secret leakage via `ps` / shell history | `--hmac-key <value>` rejected; use env or key file only |

### Honest limits (not mitigated here)

- **Without `hmacKey`:** an attacker who can replace the entire evidence and promotion file set with newly hashed forgeries can invent a valid local chain. Integrity then depends on filesystem permissions and operational controls. The optional HMAC binds records to a secret the attacker does not have.
- **Deleting `HEAD` together with the tip promotion (or rewriting the whole tree) without an external anchor:** local `verifyPromotions()` may see an empty or attacker-chosen chain as “ok”. Keep an external copy of the tip id and call `verifyPromotions({ expectedHead })`.
- **With a leaked `hmacKey`:** forged sealed records become possible.
- This module does not authenticate remote runners, sandbox commands, or prove that `command` was actually executed. It only stores and checks claims you feed it.
- It is not a substitute for code review, signature of Git objects, or deployment attestation.

## Input limits

- `command` ≤ 4096 characters; null bytes rejected
- `runner` ≤ 256 characters
- `approver` ≤ 256 characters
- Paths are resolved under the store directory; ids must be 64-hex (no `../` escape)

## Related

- Conceptual notes: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Implementation: [../src/qa-evidence.mjs](../src/qa-evidence.mjs)
