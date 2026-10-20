# HTTP agent adapter example

Educational JSON-RPC 2.0 HTTP adapter for multi-host routers. Runs entirely on the local loopback interface with a mock server. No cloud product or external network is required.

한국어: 로컬 목 서버만 쓰는 HTTP JSON-RPC 어댑터 예제입니다.

## Files

- `adapter.mjs` — `createHttpAgentHost({ url, timeoutMs, maxResponseBytes })` returns `{ send(request, { signal }) }`
- `mock-server.mjs` — temporary-port mock with modes: `ok`, `delay`, `drop`, `bad-json`, `wrong-id`, `both-result-error`, `huge`
- `demo.mjs` — starts the mock, sends one request, prints the result

## Phase contract

Failures attach `Error.phase` for routers that must decide whether bytes may have reached the peer:

| phase | meaning |
|---|---|
| `before_send` | Failure before request bytes were written (connection refused, DNS failure) |
| `after_send` | Failure after the request was written (dropped connection, invalid JSON-RPC) |
| `unknown` or omitted | Uncertain (timeout while sending/waiting, abort) |

Invalid responses are never treated as success. Error messages must not include the request body or credentials.

## Run

```bash
node examples/http-agent-adapter/demo.mjs
# or
npm run example:http
```

## Limits

- Sample only: no TLS client auth, retries, or production pooling
- Response bodies are capped (`maxResponseBytes`)
- Redirects are rejected
