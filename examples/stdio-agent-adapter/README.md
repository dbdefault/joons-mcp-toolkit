# stdio agent adapter example

Educational newline-delimited JSON-RPC 2.0 adapter over a child process stdin/stdout. Uses a local mock agent only.

한국어: 자식 프로세스 stdio 로 JSON-RPC 를 주고받는 어댑터 예제입니다.

## Files

- `adapter.mjs` — `createStdioAgentHost({ command, args, timeoutMs, maxLineBytes })` returns `{ send, close, pid }`
- `mock-agent.mjs` — child modes: `ok`, `exit-after-read`, `bad-json`, `wrong-id`, `both-result-error`, `late`, `huge`
- `demo.mjs` — spawns the mock agent, sends one request, prints the result

## Phase contract

Same router contract as the HTTP example:

| phase | meaning |
|---|---|
| `before_send` | Process failed to start, or the host was already closed |
| `after_send` | Request was written, then the child exited early or returned an invalid JSON-RPC line |
| `unknown` or omitted | Timeout or abort while waiting |

Matched by JSON-RPC `id`. Oversized lines are rejected. stderr is kept only as a short diagnostic tail and is not copied into success payloads.

## Run

```bash
node examples/stdio-agent-adapter/demo.mjs
# or
npm run example:stdio
```

## Limits

- One child process per host object; call `close()` when finished
- Not a full MCP client feature set (no capability negotiation beyond raw JSON-RPC lines)
- Sample only: no sandboxing of the child beyond what the OS provides
