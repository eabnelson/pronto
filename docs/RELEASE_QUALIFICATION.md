# Release qualification

Public release requires every automated gate and an owner-run live smoke. This
file records capability evidence, not private conversation data.

## Current matrix

| Surface | Qualified version | Evidence | Status |
| --- | --- | --- | --- |
| macOS | 26.5.1 (25F80) | Local build and synthetic suite | Pass |
| Bun | 1.3.14 | Frozen install, typecheck, tests, compiled build | Pass |
| imsg | 0.14.1 | Protocol v1 initialize, database readiness, method qualification | Pass |
| Codex CLI | 0.146.1 | Auth/help inspection and adapter fixtures | Pass |
| Claude Code | 2.1.226 | Auth/help inspection and adapter fixtures | Pass |
| Codex effective local probe | 0.146.1 | Existing configured MCP OAuth prevents turn startup | Blocked locally |
| Claude effective local probe | 2.1.226 | Existing noninteractive policy denied temporary write | Blocked locally |
| Messages Automation | Owner test chat | `docs/LIVE_SMOKE.md` | Pending |
| Full tagged flow | Owner test chat | Core and multi-turn smoke | Pending |

The matrix records versions tested on 2026-08-15. Capability checks, not version
strings alone, determine whether setup and startup proceed.

## Automated release gates

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun test`
- `bun run build`
- `bun run release:validate`
- Clean-room provenance and third-party notices present
- No dependency or import from Studio Four packages
- No model override or inherited interactive permission mode in adapters
- Exact unrestricted no-prompt flag present in each runtime adapter and required
  by setup qualification
- Synthetic duplicate, fallback, recovery, queue, privacy, and ambiguous-send
  cases pass against an on-disk SQLite database

## Owner-only gate

Run `docs/LIVE_SMOKE.md` after installing the exact release candidate. Replace
the two Pending cells above with the date and Pass only after exactly-one reply,
recent context, tagged continuity, restart suppression, and content-free logs are
observed. Do not publish a GitHub release while either cell is Pending.
