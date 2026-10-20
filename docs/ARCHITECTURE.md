# Architecture and design rationale

## State model

A job begins as a request with a stable identifier and a canonical description. The coordinator reserves the identifier before execution. A running operation may finish successfully, fail definitively, or enter an UNKNOWN state when transport fails after dispatch. UNKNOWN must not be treated as FAILED or automatically retried: the operation may already have changed remote state.

## Host routing

Routing semantics for this repository live in [ROUTER.md](./ROUTER.md). In short: record the requested host, selected host, and whether dispatch may have started; an explicit target must not silently change hosts; automatic failover is only safe when the system can prove no side effect occurred (or the operation is durably idempotent). The implementation core is `src/router.mjs`; `src/host-router.mjs` is a compatibility facade over that core.

## Verification

An independent QA report must bind the test evidence to the exact source revision. Human-readable short SHA prefixes are useful in logs but complete revisions should be stored for durable provenance. A successful isolated test is not evidence of successful production deployment.

## Security boundaries

Authentication, authorization, filesystem scope, secret handling, and execution sandboxing belong at the trusted enforcement boundary. This repository does not provide production authentication or remote execution. The sample code should not be deployed as a public endpoint.

## Persistence and recovery

The sample uses memory and loses its ledger on restart. A production implementation needs transactional durable state, worker fencing tokens, retention policy, and recovery that can query remote operation status before any retry. All output and metadata need bounded storage.

## Testing strategy

Test normal operation, concurrent duplicate requests, conflicting payloads, malformed receipts, transport failures before and after dispatch, process exits, partial responses, host loss, restart recovery, and QA revision mismatch. Never conflate simulated conditions with production proof.
