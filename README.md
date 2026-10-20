# JOONS MCP Toolkit

**Reference patterns for reliable AI agents, Model Context Protocol (MCP) tools, and multi-host orchestration.**

> Status: early open-source reference project. The public examples are standalone and do **not** expose or require the private JOONS CORE installation. They are not a production-ready remote execution gateway.

## Why this project exists

AI agents increasingly operate across tools, computers, processes, and long-running tasks. The hardest failures are often not model failures: an RPC reply disappears after an operation succeeds; a supervisor retries work on another machine; a job is marked successful despite an invalid response; or a quality gate approves code that was never actually tested. These are distributed-systems and software assurance problems.

JOONS MCP Toolkit documents practical patterns to make agent operations **observable, bounded, explicit, recoverable, and auditable**. It is informed by engineering experience building a private multi-machine AI automation environment, but this repository contains independently written generic examples and no private deployment history.

## Project goals

1. **Safe tool routing:** distinguish target selection from transport availability. An explicitly selected host must not silently change.
2. **Idempotent jobs:** identify operations by stable request IDs; reject conflicting payloads; never equate a transport timeout with an unexecuted operation.
3. **Correct outcomes:** distinguish ACCEPTED, RUNNING, SUCCEEDED, FAILED, and UNKNOWN. A missing receipt is not success.
4. **Defensible QA:** associate verification with a precise code revision, test command, and evidence. Never promote mismatched code to verified.
5. **Recoverable workflows:** preserve immutable evidence, avoid duplicate dispatch, and support deliberate reconciliation.
6. **Least surprise:** expose clear boundaries and useful diagnostics without exposing secrets or personal data.

## Architecture (conceptual)

```text
User / ChatGPT / Claude
          |
          v
   MCP-facing adapter
          |
          v
  Policy + target router
          |
          v
 Durable request ledger ----> Audit / QA evidence
          |
    +-----+-----+
    |           |
Local agent  Remote worker(s)
    |           |
    +---- result/receipt ----+
```

The reference architecture separates **control plane** (what to run, where, under which policy) from **execution plane** (the host actually doing the work). It does not claim to implement a complete control plane today.

## Available reference modules

### Idempotent request coordinator
A small dependency-free JavaScript implementation demonstrates stable request IDs, payload fingerprints, in-flight deduplication, conflicting-request rejection, explicit outcome recording, and UNKNOWN states. It is an **in-memory educational reference**, not a durable queue. See [src/request-coordinator.mjs](src/request-coordinator.mjs).

### Tests
The built-in Node.js test runner covers concurrent same-ID calls, payload conflicts, failed operations, and ambiguous transport outcomes. Run `npm test`.

### Design notes
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers routing, state transitions, trust boundaries, and deployment cautions.

### Examples
- [HTTP agent adapter](examples/http-agent-adapter/) — local JSON-RPC 2.0 POST host with phase-tagged transport errors
- [stdio agent adapter](examples/stdio-agent-adapter/) — local newline-delimited JSON-RPC child-process host

## Quick start

Requires Node.js 20 or later. No API key or cloud service is needed.

```bash
git clone https://github.com/dbdefault/joons-mcp-toolkit.git
cd joons-mcp-toolkit
npm test
```

For a short demonstration:

```bash
node examples/demo.mjs
```

## Reliability principles

| Situation | Unsafe assumption | Preferred handling |
|---|---|---|
| Remote request times out after send | The work never ran | Mark UNKNOWN and reconcile by request ID |
| Two identical requests arrive together | Run both | Share one in-flight execution |
| Same ID has different arguments | Reuse old result | Return a conflict |
| Worker returns malformed response | Treat as empty success | Reject with a structured error |
| QA result refers to older revision | Promote latest revision | Require matching verification revision |
| Target host is explicitly chosen | Silently switch hosts | Fail visibly, without fallback |
| Process exits before RPC response | Wait until timeout | Surface early exit and clean up |

## Current scope and limitations

- **Included:** reference coordinator, tests, conceptual architecture, contributing/security documentation.
- **Not included:** production gateway, host discovery, remote shell execution, Android client, real OAuth integration, hosted orchestration, private logs, proprietary code, or third-party agent source.
- **Persistence:** the sample coordinator is in-memory. Restart-safe deduplication requires durable storage and an atomic dispatch protocol.
- **Security:** samples illustrate contracts, not a substitute for sandboxing, authentication, authorization, secret management, or penetration testing.
- **Benchmarks:** no public deployment or performance benchmarks are claimed.

## Roadmap

- Persistent request ledger with transactional reservation and recovery
- MCP JSON-RPC validation examples with adversarial fixtures
- Host selection and explicit no-fallback routing contracts
- Portable evidence format for independent QA and code-revision checks
- Safe examples for Hermes-style and bot-style adapters (without vendor internals)
- Cross-platform tests and fault-injection harnesses
- Documentation for self-hosted deployments and rollback

Roadmap items are proposals, **not shipped features**.

## Open-source participation

Contributions, bug reports, design reviews, and documentation improvements are welcome. Please see [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). We especially welcome test cases that distinguish confirmed execution from uncertain delivery, and designs that avoid silent duplicate side effects.

## License

MIT — see [LICENSE](LICENSE).

## Provenance and transparency

This public repository was created as a clean, standalone project. The private JOONS CORE system and its repositories are **not** mirrored here. The author maintains private AI orchestration tooling; claims of widespread public adoption, package downloads, external contributors, or third-party production use are **not** made.

### About the maintainer

The maintainer explores practical AI agent orchestration, multi-machine automation, MCP integrations, fault-tolerant workflows, and independent software QA. The goal of this open-source project is to turn generalizable engineering lessons into small, testable building blocks that others can inspect and extend.

---

**If you are evaluating this project for an open-source support program:** please judge the published source, reproducible tests, maintenance activity, and community contribution history. Private development activity is background context, not evidence of public package adoption.
