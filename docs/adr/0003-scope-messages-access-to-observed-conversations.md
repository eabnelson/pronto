---
status: accepted
---

# Scope Messages access to observed conversations

The public Pronto Messages Module keeps the raw `imsg` RPC client internal. It emits the stable provider facts a consumer needs, but history and attachment access require module-issued references bound to one observed conversation, with explicit budgets and expiry; the package root exposes no arbitrary global Messages search. This gives up low-level convenience so each consumer uses the same exact-conversation path that Pronto qualifies and tests.

## Consequences

Codex and Claude runtime adapters remain in the standalone Pronto CLI rather than the Messages module. The module shares structured capability probes and privacy-safe diagnostics, while each consumer owns presentation, installation, updates, signing, LaunchAgent identity, and permission walkthroughs. Its TypeScript implementation uses standard ESM and `node:` interfaces without Bun globals so both Node and Bun consumers can use it.

Serialized provider events, checkpoints, sealed references, and SQLite state carry explicit versions. State migration is monotonic, creates a backup before mutation, rejects unknown newer versions, and fails closed when a Messages database generation cannot be proven.
