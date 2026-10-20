# Security policy

This project provides educational reference code, not a production-secure gateway. Do not expose the sample coordinator as an unauthenticated public service.

## Reporting vulnerabilities

Please avoid posting exploit details or secrets in public issues. Contact the repository maintainer privately through GitHub's private vulnerability reporting feature if enabled, or request a secure reporting channel without sharing sensitive details.

## Design requirements

- Validate RPC envelopes and receipts before declaring success.
- Treat post-send transport failures as uncertain outcomes.
- Never log tokens, passwords, private keys, customer content, or raw confidential prompts.
- Scope filesystem and command access to explicit permissions.
- Pin exact code revisions for independent QA.
- Prefer bounded output, timeouts, cancellation, and durable reconciliation over blind retries.

## Supported versions

This is a pre-1.0 reference project. No formal long-term security support window is promised.
