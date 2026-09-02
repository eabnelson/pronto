# Release qualification

Public release requires every automated gate and an owner-run live smoke. This
file records capability evidence, not private conversation data.

## Current matrix

| Surface | Qualified version | Evidence | Status |
| --- | --- | --- | --- |
| macOS | 26.5.1 (25F80) | Local build and synthetic suite | Pass |
| Bun | 1.3.14 | Frozen install, typecheck, tests, compiled build | Pass |
| Node.js | 22.23.1 | Clean packed `pronto-imessage` import and public-interface smoke | Pass |
| imsg | 0.14.1 | Protocol v1 initialize, database readiness, method qualification | Pass |
| Codex CLI | 0.146.1 | Auth/help inspection and adapter fixtures | Pass |
| Claude Code | 2.1.226 | Auth/help inspection and adapter fixtures | Pass |
| Codex effective local probe | 0.146.1 | Setup noninteractive file-tool probe | Pass |
| Claude effective local probe | 2.1.226 | Setup noninteractive file-tool probe | Pass |
| Messages Automation | Owner test chats, 2026-09-02 | Exactly one self-chat send and one RCS send; expected self-chat display mirror only | Pass |
| Self-chat mirror handling | Owner self-chat, 2026-09-02 | One tagged activation and one agent send with no echo turn | Pass |
| Full remote tagged flow | v0.2.0 | Owner RCS chat, 2026-09-02: exact re-resolution, one tagged activation, one confirmed reply, no echo turn | Pass |

The automated matrix and owner smoke record versions tested on 2026-09-02.
Capability checks, not version
strings alone, determine whether setup and startup proceed.

## Automated release gates

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun test`
- `bun run build`
- `bun run release:validate`
- Packed `pronto-imessage` imports successfully under Node.js 22.23.1 and Bun 1.3.14
- Compiled `pronto` version/help and legacy `s4imsg` version smoke checks
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

Run `docs/LIVE_SMOKE.md` after installing the exact release candidate. Mark the
remote row Pass only after a remote participant's exactly-one reply, recent
context, tagged continuity, restart suppression, and content-free logs are
observed. Do not publish a GitHub release while any cell is Pending or Blocked.
