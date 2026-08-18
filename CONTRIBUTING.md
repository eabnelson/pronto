# Contributing

Contributions are welcome. Please open a focused issue before starting a large
behavioral change so the security and privacy contract can be discussed first.

## Local development

You need macOS, Bun 1.3.14 or newer, and the source-install requirements from
the [README](README.md).

```sh
git clone https://github.com/eabnelson/s4imsg.git
cd s4imsg
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun run release:validate
```

The automated suite uses synthetic fixtures and does not read or send iMessages.
Run the owner-only [live smoke checklist](docs/LIVE_SMOKE.md) only when a change
affects the real Messages integration.

## Project rules

- Keep the project independent of Studio Four packages and services.
- Use synthetic message fixtures only.
- Add focused tests for behavior changes.
- Never put message text, handles, chat identifiers, attachment paths,
  credentials, or provider output in issues, fixtures, snapshots, or logs.
- Do not add rich outbound Messages mutations without a separately reviewed
  product decision.

## Pull requests

- Keep each pull request small enough to review as one coherent change.
- Explain user-visible behavior and security implications.
- Run `bun run typecheck`, `bun test`, `bun run build`, and
  `bun run release:validate` before opening it.
- Do not commit generated `dist/` output or real local configuration.

Report vulnerabilities through a private GitHub security advisory as described
in [SECURITY.md](SECURITY.md), not through a public issue.
