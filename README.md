# s4imsg

`s4imsg` is a small, local macOS bridge that listens for a configurable tag in
iMessage conversations, runs either Codex or Claude Code, and replies with
plain text.

The project is under active development. It is source-first, stores only
bounded tagged memory, and does not require Studio Four.

## Requirements

- macOS 14 or newer with Messages signed in
- [Bun 1.3.14](https://bun.sh/)
- [imsg](https://github.com/openclaw/imsg)
- An authenticated Codex or Claude Code CLI

## Development

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run build
```

## Status

The first public release is not yet qualified. Do not use it for important
conversations until the release validation and live macOS checks pass.

## License and trademarks

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This project is not affiliated with Apple, Anthropic, or OpenAI. iMessage,
Claude, and Codex are trademarks of their respective owners.
