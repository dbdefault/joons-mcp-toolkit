# QA evidence store

Immutable, content-addressed records that bind automated test results to an exact Git commit SHA. Promotion (release / PR-ready) decisions are derived only from those records.

한국어 요약: 이 모듈은 “수정 커밋에 대한 독립 QA 증거”를 파일로 남기고, 승격 가능 여부를 증거만으로 판정합니다. 짧은 SHA·다른 커밋의 PASS 재사용·변조된 파일은 거부합니다. HMAC 키 없이도 내용 해시로 변조는 탐지하지만, 키 없이 파일을 통째로 다시 쓰는 공격자는 막지 못합니다.

## Why

A green test log that does not name the revision under test is not sufficient to promote that revision. This module stores:

- `fixSha` — the commit proposed for promotion
- `testedSha` — the commit the tests actually ran against
- command, exit code, pass/fail counts, and a SHA-256 of the captured output

Promotion is allowed only when at least one evidence record proves a successful run against the **same** full SHA.

## API sketch

```js
import {
  createEvidenceStore,
  evaluatePromotion,
  promote,
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
const decision = evaluatePromotion(store, fixSha);
if (decision.promotable) promote(store, fixSha, { approver: 'ci-bot' });
```

CLI:

```bash
node src/qa-evidence-cli.mjs record --dir ./qa-store --fix <sha> --tested <sha> \
  --cmd "node --test" --exit 0 --passed 12 --failed 0 --output-file ./out.txt
node src/qa-evidence-cli.mjs check --dir ./qa-store --fix <sha>
```

## SHA rules

- Only full 40-character hexadecimal SHAs are accepted.
- Uppercase digits are normalized to lowercase.
- Short SHAs, empty values, and non-hex strings are rejected.

## Storage layout

```text
<dir>/evidence/<evidenceId>.json     # exclusive create (wx), fsync, best-effort chmod a-w
<dir>/promotions/<fixSha>.json      # written only after a successful evaluatePromotion
```

`evidenceId` is the SHA-256 of the canonical JSON of the semantic fields (sorted keys), excluding `recordedAt` and `seal`. Re-recording identical semantic content returns the same id and does not grow the file set. Concurrent identical writes still leave a single file.

If a file already exists for an `evidenceId` but the semantic content differs, the store raises `TamperedEvidenceError`.

## Promotion rules

`evaluatePromotion(store, fixSha)` returns `{ promotable, reasons, evidenceIds }`.

A record counts as passing only when all of the following hold:

1. `testedSha === fixSha` (exact match; another commit’s PASS never applies)
2. `exitCode === 0`
3. `failed === 0`
4. `passed >= 1`
5. `command` and `outputHash` are well-formed

Notes:

- Later commits do not inherit older evidence: each `fixSha` is evaluated independently.
- If both failing and passing evidence exist for the same `fixSha`, the default policy still allows promotion when a passing record exists, and records a conflict in `reasons`.
- With `strict: true` (store option or evaluate option), any failing evidence for that SHA refuses promotion.
- `promote` refuses with `PromotionRefusedError` and creates no promotion file when evaluation fails. Re-promoting the same SHA is idempotent.

## Threat model

### Mitigations

| Threat | Handling |
|---|---|
| Accidental reuse of another commit’s PASS | `testedSha` must equal `fixSha` |
| Short / ambiguous SHA | Rejected at ingest |
| Bit-flip or hand-edit of a stored JSON file | Content hash must equal `evidenceId` on every read |
| Duplicate concurrent inserts of the same result | Exclusive create + content-addressed id → one file |
| Unsigned records when an HMAC key is configured | Missing/invalid `seal` → `TamperedEvidenceError` |
| Wrong HMAC key | Seal verification fails |

### Honest limits (not mitigated here)

- **Without `hmacKey`:** an attacker who can replace the entire evidence file with a newly hashed forgery can invent a valid `evidenceId`. Integrity then depends on filesystem permissions and operational controls. The optional HMAC binds records to a secret the attacker does not have.
- **With a leaked `hmacKey`:** forged sealed records become possible.
- This module does not authenticate remote runners, sandbox commands, or prove that `command` was actually executed. It only stores and checks claims you feed it.
- Deleting evidence files is not prevented; absence simply makes promotion fail.
- It is not a substitute for code review, signature of Git objects, or deployment attestation.

## Input limits

- `command` ≤ 4096 characters; null bytes rejected
- `runner` ≤ 256 characters
- `approver` ≤ 256 characters
- Paths are resolved under the store directory; `evidenceId` values must be 64-hex (no `../` escape)

## Related

- Conceptual notes: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Implementation: [../src/qa-evidence.mjs](../src/qa-evidence.mjs)
