# Release qualification

Public release requires every automated gate and an owner-run live smoke. This
file records capability evidence, not private conversation data.

## Current matrix

| Surface | Qualified version | Evidence | Status |
| --- | --- | --- | --- |
| macOS | 26.5.1 (25F80) | Local build and synthetic suite | Pass |
| Bun | 1.3.14 | Frozen install, typecheck, tests, compiled build | Pass |
| Node.js | 22.23.1 | Clean packed `pronto-imessage` import and public-interface smoke | Pass |
| imsg | 0.15.0 | Exact signed upstream artifact qualified against protocol v1; provider code unchanged since the 0.2.4 qualification | Pass |
| Codex CLI | 0.153.0 | Auth/help inspection and adapter fixtures | Pass |
| Claude Code | 2.1.260 | Auth/help inspection and adapter fixtures | Pass |
| Codex effective local probe | 0.153.0 | Setup noninteractive file-tool probe | Pass |
| Claude effective local probe | 2.1.226 | Setup noninteractive file-tool probe | Pass |
| Messages Automation | v0.3.0 signed candidate | Pending Developer ID build, one-time FDA migration, and exactly-one send evidence | Pending |
| Self-chat mirror handling | v0.3.0 signed candidate | Pending one tagged activation and one agent send with no echo turn | Pending |
| Full remote tagged flow | v0.3.0 | Pending exact signed candidate remote-chat evidence and signed-to-signed update continuity | Pending |

The automated matrix and owner smoke record versions tested on 2026-09-04.
Capability checks, not version
strings alone, determine whether setup and startup proceed.

## Automated release gates

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun test`
- `bun run build`
- `bun run release:validate`
- Packed `pronto-imessage` imports successfully under Node.js 22.23.1 and Bun 1.3.14
- Compiled `pronto` version/help and strict macOS signature smoke checks
- Clean-room provenance and third-party notices present
- `pronto-imessage` is packed, checksummed, attached to the immutable GitHub
  release, and published to npm with provenance only after this matrix passes
- No dependency or import from Studio Four packages
- No model override or inherited interactive permission mode in adapters
- Exact unrestricted no-prompt flag present in each runtime adapter and required
  by setup qualification
- Synthetic duplicate, fallback, recovery, queue, privacy, and ambiguous-send
  cases pass against an on-disk SQLite database
- Static ownership checks reject any standalone provider RPC client, parser, probe,
  raw watch/catch-up methods, or direct provider-history implementation outside
  `pronto-imessage`

## Owner-only gate

Run `docs/LIVE_SMOKE.md` after installing the exact release candidate. Normally,
mark the remote row Pass only after a remote participant's exactly-one reply,
recent context, tagged continuity, restart suppression, and content-free logs are
observed. When the checklist's narrowly scoped carry-forward exception applies,
record the prior remote release, fresh exact-candidate self-chat evidence, and the
reviewed unchanged surfaces in the matrix. Do not publish a GitHub release while
any cell is Pending or Blocked.
