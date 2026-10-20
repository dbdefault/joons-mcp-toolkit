# Durable Request Ledger

Append-only, single-host request ledger for idempotent work with crash recovery.

## State machine

```
ACCEPTED → RUNNING → SUCCEEDED
                   → FAILED
                   → UNKNOWN → SUCCEEDED   (via reconcile only)
```

- Terminal states `SUCCEEDED` and `FAILED` are immutable.
- `UNKNOWN` means the process may have already performed side effects; do not auto-retry.
- `reconcile(id, result)` is the only path from `UNKNOWN` to `SUCCEEDED` and requires a receipt (`result !== undefined`).

## Durability guarantees and limits

- Each event is one JSON line in `ledger.jsonl` with monotonic `seq` and a `crc` (first 16 hex chars of SHA-256 over the event body without `crc`).
- With `fsync: true` (default), an append calls `handle.sync()` before memory is updated and the call resolves. A failed write leaves memory unchanged.
- With `fsync: false`, a sudden power loss may drop the most recent events.
- Designed for a **local filesystem on a single host**. Network filesystems are not recommended (lock and `rename` semantics vary).
- Payload bodies are not stored; only a SHA-256 fingerprint is kept.
- Line size cap: 256 KiB. `result` / `error` JSON size cap: 64 KiB (`LedgerLimitError`, no silent truncation).

## Locking

- `Ledger.open(dir)` creates `ledger.lock` with exclusive create (`wx`) and records `{ pid, token, startedAt, port }`.
- A second live process receives `LedgerLockedError` (optional `lockTimeoutMs` retries).
- Liveness uses the lock file plus a loopback TCP bind on a port derived from the directory path (PID-only checks are unreliable on some hosts). If the holder process exits, the port is released and the next opener may reclaim.
- `close()` closes the lock listener and removes the lock file only when the token matches.

## Recovery on open

1. Replay all lines; verify `seq` continuity and `crc`.
2. If the **last** line is incomplete (JSON parse failure from a partial write), truncate back to the last good byte offset and set `ledger.recovery = { truncatedBytes }`.
3. If a **middle** line is broken, or any line has a bad `crc` / `seq` gap, throw `LedgerCorruptError` (no silent skip).
4. Requests left in `RUNNING` are moved to `UNKNOWN` via a `recovered` event (side effects may already have happened).
5. `ACCEPTED` requests stay `ACCEPTED`.

## API sketch

```js
import { Ledger } from '../src/ledger.mjs';
import { RequestCoordinator } from '../src/request-coordinator.mjs';

const ledger = await Ledger.open(dir, { fsync: true });
const coord = new RequestCoordinator({ ledger });

const result = await coord.run('job-1', { op: 'create' }, async (payload) => {
  // perform work; must return a receipt (not undefined)
  return { ok: true };
});

// After a crash that left UNKNOWN:
// coord.reconcile('job-1', { ok: true });

await ledger.close();
```

Without `{ ledger }`, `RequestCoordinator` stays in-memory and matches the v0.1.0 API.

## Optional compact

`compact()` rewrites the log to the minimal event sequence for current records using a temp file, `fsync`, and atomic `rename`, while the lock is held.

## Limits (summary)

| Topic | Behavior |
| --- | --- |
| Power loss + `fsync: false` | Recent events may be lost |
| Network FS | Not recommended |
| `UNKNOWN` | Manual `reconcile` only; no automatic retry |
| Multi-process | One writer via `ledger.lock` |
| Privacy | Fingerprints only; no raw payloads on disk |

## Korean summary (optional)

추가 전용 JSONL 원장으로 요청 상태를 내구성 있게 기록합니다. 기본은 fsync 후 메모리 반영입니다. 재시작 시 RUNNING은 UNKNOWN으로 바꾸며 자동 재시도하지 않습니다. 단일 호스트 로컬 디스크를 전제로 하며, 네트워크 파일시스템은 권장하지 않습니다.
