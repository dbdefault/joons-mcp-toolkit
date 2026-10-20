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

- Same `requestId` + same request fingerprint: one in-flight promise; later callers share it.
- Same `requestId` + different request: `FAILED` with a conflict message.
- Default store is an in-memory `Map` with a size cap (default 10_000). Oldest **completed** entries are dropped first; in-flight entries are kept.
- Optional `{ get, set }` store injection is supported for experiments. Durable persistence is out of scope (separate ledger work).

## Safety

- Error messages copied into results are stripped of control characters and capped (200 chars).
- The router does not echo the request body, tokens, or secrets into `result` / `attempts`.
- Synchronous throws from `send` are caught.
- Optional `AbortSignal`: abort detected **before** calling `send` is treated like `before_send` (fallback allowed when target is unset). Ambiguity after send remains `UNKNOWN`.

## Limits

- No durable ledger across process restarts.
- No built-in network client, discovery, auth, or MCP session management.
- Host adapters are responsible for real transport semantics and honest `phase` labeling.
- Custom stores must implement their own retention if they ignore the default eviction path.
