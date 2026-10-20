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

- `Ledger.open(dir)` creates a `ledger.lock/` directory with non-recursive `fs.mkdir` (atomic exclusive create) and writes `owner.json` as `{ pid, token, startedAt }`.
- While the event loop is alive, an `unref` timer every `staleMs / 2` refreshes the lock directory mtime via `fs.utimes`. Default `staleMs` is 15000 (overridable for tests).
- Another process sees:
  - lock present and mtime within `staleMs` → `LedgerLockedError` (optional `lockTimeoutMs` retries);
  - mtime older than `staleMs` → stale reclaim via `fs.rename(lockDir, lockDir + '.stale-' + token)`, verify the moved mtime was really stale (otherwise `LedgerLockedError` without renaming back), remove it, then `mkdir` again.
- `owner.json` still records `pid` for diagnostics; reclaim decisions prefer mtime so a false `ESRCH` cannot steal a live lock with a fresh heartbeat.
- `close()` stops the heartbeat and removes the lock directory only when `owner.json` token matches.
- If the heartbeat finds the directory gone or a foreign token, the instance is marked compromised and further writes throw `LedgerLockedError('lock lost')`.

### Lock limits

- If the owning process blocks the event loop longer than `staleMs`, another process may reclaim the lock.
- After a crash, reclaim happens once mtime is older than `staleMs` (heartbeat stopped). Use a smaller `staleMs` in tests.
- Single-host local filesystem only; network filesystems are not recommended.

## RequestCoordinator + ledger

- `new RequestCoordinator()` (no ledger) keeps the v0.1.0 in-memory API: `reconcile` is synchronous and returns `undefined`.
- `new RequestCoordinator({ ledger })` is durable: `reconcile(id, result)` returns a **Promise** and updates in-memory state only after the ledger write succeeds (failure rejects and leaves memory unchanged).
- If `execute` succeeds but persisting `succeed` fails, `run` throws `LedgerWriteError` (does not return the execute result). After restart that request becomes `UNKNOWN`.

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
  return { ok: true };
});

// After a crash that left UNKNOWN (durable reconcile is async):
// await coord.reconcile('job-1', { ok: true });

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
| Multi-process | One writer via `ledger.lock/` + heartbeat |
| Blocked event loop > `staleMs` | Lock may be reclaimed |
| Privacy | Fingerprints only; no raw payloads on disk |

## Korean summary (optional)

추가 전용 JSONL 원장으로 요청 상태를 내구성 있게 기록합니다. 잠금은 `ledger.lock/` 디렉터리와 mtime 하트비트입니다. 재시작 시 RUNNING은 UNKNOWN으로 바꾸며 자동 재시도하지 않습니다. ledger가 있을 때 reconcile은 Promise이며 기록 성공 후에만 메모리를 바꿉니다.
