# Testing

Keep tests proportional to the behavior and the cost of a mistake. Prefer a small
test through the interface callers use. Preserve focused regressions for real bugs.

- Keep routing/scope isolation, credentials, delivery deduplication, ambiguous
  sends, persistence/migration and rollback coverage.
- Use a table for variations of one rule. Add a separate case when it proves a
  distinct outcome; do not merge unrelated failures just to lower the test count.
- Assert outcomes, not private call order, exact prose, CSS values, image hashes
  or animation timing. Visually check low-impact appearance changes when needed.
- Test behavior at its owning module. Use integration tests for wiring and durable
  effects; avoid repeating every lower-level edge case through every layer.
- Use synthetic accounts and disposable state. Do not turn routine tests into
  live account, model, network or power-management exercises.

## Commands

Run the relevant test file while editing. Before merging, CI runs typecheck, the
Bun suite, Swift tests, native Go tests, build and package validation once each.
Use `bun test test/integration` when working on coordinator wiring.

`bun run release:validate` checks packaging, compiled CLI startup, packed imports
under Node/Bun, licenses, provider ownership and publication controls. It does not
rerun runtime tests already covered by `bun test`. Signed packaging additionally
checks signing, notarization and final artifact startup. Static site deployment
runs only site/workflow tests and never compiles the messaging app.

## Release smoke

Use the three results in [LIVE_SMOKE.md](LIVE_SMOKE.md): installed startup,
changed app flow and rollback readiness. Owner daily use is useful evidence.
Reuse named observations for reviewed unchanged behavior. Slack's four beta
entries are described in [SLACK_QUALIFICATION.md](SLACK_QUALIFICATION.md).

Long sleep, fixed-duration benchmarks and exhaustive platform/account matrices
are follow-up investigations or targeted checks for relevant changes, not routine
release gates. Never relabel an unperformed test as passed. Reported failures in
supported behavior still need investigation before release.
