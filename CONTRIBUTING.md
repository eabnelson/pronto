# Contributing

Contributions are welcome after the first release contract is stable.

- Keep the project independent of Studio Four packages and services.
- Use synthetic message fixtures only.
- Add focused tests for behavior changes.
- Run `bun test`, `bun run typecheck`, and `bun run release:validate` before
  opening a pull request.
- Do not add rich outbound Messages mutations without a separately reviewed
  product decision.
