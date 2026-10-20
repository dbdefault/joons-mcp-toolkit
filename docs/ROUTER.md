# Multi-Host Router

English first. Korean notes are secondary.

여러 실행 호스트로 요청을 보내는 라이브러리 계층의 의미와 한계를 정리한다.

## Purpose

`createRouter` selects which host adapter should run a request, records attempts, and returns a bounded outcome. It does **not** open network sockets itself. Host adapters supply `send` and optional `isAvailable`.

## API sketch

```js
import { createRouter } from '../src/router.mjs';

const router = createRouter({
  hosts: [
    {
      id: 'host-a',
      priority: 1,
      isAvailable: () => true,
      async send(request, ctx) {
        // Adapter-owned transport. Throw with err.phase = 'before_send' | 'after_send'.
        return { ok: true };
      },
    },
    { id: 'host-b', priority: 2, async send(request) { return { ok: true }; } },
  ],
});

const result = await router.route({
  requestId: 'job-1',
  request: { action: 'ping' },
  // target: 'host-a', // optional explicit host
});
```

Result shape:

| Field | Meaning |
|---|---|
| `status` | `SUCCEEDED` \| `FAILED` \| `UNKNOWN` |
| `host` | Host id that produced the terminal outcome (or last attempt) |
| `attempts` | Per-host `{ host, outcome: 'ok'\|'error'\|'skipped', phase? }` |
| `value` | Present on success only |
| `error` | Sanitized `{ message }` on failure/unknown (no request body) |

## State transitions

```text
route(requestId)
    │
    ├─ known id + different fingerprint  → FAILED (conflict), no send
    ├─ known id + same fingerprint       → return recorded result (or await in-flight)
    └─ new id
         ├─ target set
         │    ├─ unknown id              → FAILED, send count 0
         │    └─ that host only          → SUCCEEDED | FAILED | UNKNOWN (never fallback)
         └─ target unset
              try hosts by priority asc, then declaration order
                   ├─ unavailable / before_send error → next host
                   ├─ success                         → SUCCEEDED (stop)
                   ├─ after_send / missing phase      → UNKNOWN (stop, no further send)
                   └─ all pre-send failures           → FAILED
```

## Phase contract

Adapters should mark transport errors with `error.phase`:

| Phase | Meaning | Fallback when target unset? |
|---|---|---|
| `before_send` | No bytes that could cause side effects were handed to the peer (connect refused, DNS failure, local abort before send, `isAvailable()===false`) | Yes |
| `after_send` | Dispatch may have reached the peer; receipt missing or ambiguous | No → `UNKNOWN` |
| missing / other | Cannot prove pre-send | No → `UNKNOWN` |

Timeouts without an explicit `before_send` phase are treated as `UNKNOWN`.

## Why UNKNOWN is not retried here

Once a send may have started, another host must not execute the same `requestId`. The work might already have changed remote state. This module returns the recorded `UNKNOWN` on replay and does not dispatch again. Deliberate reconciliation belongs to a durable ledger / operator workflow outside this file.

## Deduplication and memory

- Same `requestId` + same fingerprint (request payload + normalized target): one in-flight promise; later callers share it.
- Same `requestId` + different request or different target: `FAILED` with a conflict message (no send).
- Default store is an in-memory `Map` with a size cap (default 10_000). Oldest **completed** entries are dropped first; in-flight entries are kept.
- Optional `{ get, set }` store injection is supported for experiments. Durable persistence is out of scope (separate ledger work).

## Safety

- Error messages copied into results are stripped of control characters and capped (200 chars). The router does **not** redact or mask secret-looking substrings inside those messages; adapters must not put request bodies, tokens, or other secrets into thrown error messages.
- The router does not copy the request object into `result` / `attempts`.
- Synchronous throws from `send` are caught.
- Optional `AbortSignal`: abort detected **before** calling `send` is treated like `before_send` (fallback allowed when target is unset). Ambiguity after send remains `UNKNOWN`.
- Deduplication fingerprints include both the request payload and the normalized `target` (omitted vs explicit are distinct). A same `requestId` with a different target is a conflict and does not send.

## Legacy compatibility facade (`createHostRouter`)

`src/host-router.mjs` keeps the earlier public export names and call shape. It is a thin wrapper over `createRouter`.

| Legacy (`host-router`) | Core (`router`) |
|---|---|
| `hosts: string[]` | `hosts: [{ id, priority: index, isAvailable, send }]` |
| `isAvailable(id)` | `host.isAvailable()` closes over that `id` (sync or async) |
| `invoke(id, operation)` | `host.send(operation)` calls `invoke` |
| `call(operation, { targetHost })` | `route({ requestId, request: operation, target: targetHost })` |
| throws `HostUnavailableError` | core `FAILED` (unknown / unavailable / all pre-send failures) |
| throws `UnknownDeliveryError` | core `UNKNOWN` |
| returns invoke value | core `SUCCEEDED` → `value` |

Semantic difference: the legacy facade **always** treats an `invoke` throw as uncertain delivery. It overwrites any `error.phase` (including `before_send`) before the error reaches the core, so the core must not fall back to another host on that path. Shared error classes live in `src/routing-errors.mjs` and are re-exported from both modules so `instanceof` matches.

Each legacy `call` uses a fresh `requestId`, so the core’s request-id ledger does not dedupe successive facade calls. The core still caps completed in-memory records.

## Limits

- No durable ledger across process restarts.
- In-memory dedupe is bounded: after the completed-record cap is exceeded, older finished entries may be dropped, so the same `requestId` can run again. Cross-restart and unbounded duplicate suppression belong to a durable ledger.
- No built-in network client, discovery, auth, or MCP session management.
- Host adapters are responsible for real transport semantics and honest `phase` labeling.
- Custom stores must implement their own retention if they ignore the default eviction path.
- The legacy facade intentionally disables pre-send fallback after `invoke` throws; prefer `createRouter` when adapters can label `before_send` honestly.
