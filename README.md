# s4imsg

`s4imsg` is a small, local macOS bridge between iMessage and the Codex or Claude
Code CLI. Pick a tag such as `@helper`; when anyone uses it in an iMessage chat
you have already participated in, the bridge gives one bounded, one-shot turn to
your chosen local agent and sends one plain-text reply.

It is an independent MIT-licensed project. It does not require Studio Four,
create project folders per chat, select a model, or keep provider sessions alive.

## Before installing

The tag is not authentication. Every participant in an eligible chat can invoke
your agent with that agent's normal noninteractive local permissions. The agent
may read or modify files, run commands, use configured tools, and send conversation
material to its model provider. Untagged chat history and attachment content are
untrusted evidence, but can still influence the model. Only use `s4imsg` in chats
whose participants you trust, and tell them that tagged and nearby conversation
material may be processed by your model provider.

## Requirements

- macOS 14 or newer with Messages signed in to iMessage
- [Bun 1.3.14](https://bun.sh/) for source installation
- [`imsg`](https://github.com/openclaw/imsg) 0.14 or a capability-compatible release
- At least one authenticated [Codex CLI](https://github.com/openai/codex) or
  [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/getting-started)

Install `imsg` with its recommended Homebrew tap:

```sh
brew install steipete/tap/imsg
```

The ordinary `imsg` read, watch, and text-send path is sufficient. `s4imsg` does
not require disabling System Integrity Protection or enabling `imsg`'s private
IMCore bridge.

## Install from source

Clone this repository, then run:

```sh
bun install --frozen-lockfile
bun run src/cli.ts setup
```

Setup asks for:

1. A tag matching `@[A-Za-z0-9_-]{1,32}`; the default is `@s4`.
2. A primary runtime when both Codex and Claude Code are installed.
3. Whether to use the other runtime as a fallback.
4. Explicit acceptance of the trust model above.

Setup then performs one temporary noninteractive file-tool probe per selected
runtime. This uses the runtime's existing account, default model, user
configuration, hooks, tools, and permission policy. No model ID, sandbox mode, or
approval-bypass mode is supplied by `s4imsg`.

After qualification, setup compiles a stable executable under
`~/Library/Application Support/s4imsg/`, writes an owner-only configuration, and
installs the `dev.s4imsg.agent` user LaunchAgent.

## macOS permissions

In System Settings → Privacy & Security:

- Grant Full Disk Access to the installed `s4imsg` executable so its supervised
  `imsg rpc` child can read `~/Library/Messages/chat.db`.
- Allow Messages automation when macOS prompts during the first outbound smoke
  test. The approval belongs to the installed executable's process context.
- If setup or a manual `imsg` check runs from Terminal or another parent app,
  that app may also need Full Disk Access.

After installation, run:

```sh
~/Library/Application\ Support/s4imsg/bin/s4imsg doctor
```

`doctor` performs real read/watch and runtime probes. It cannot test Messages
Automation without sending a message, so complete the
[live test-chat checklist](docs/LIVE_SMOKE.md) once.

## Use

Send a text message such as:

```text
@helper summarize the decision and suggest the next step
```

The message must be iMessage, not SMS or RCS, and the Mac owner must previously
have sent at least one message in that chat. Tags are case-insensitive. Reactions,
polls, and attachment-only messages do not activate the agent, but the agent can
query supported reactions, polls, participants, message details, and attachment
metadata from the current chat during an active turn. Attachment bytes are never
copied into bridge storage; a verified local attachment path may be returned so
the agent can inspect it with its normal file tools.

Each turn automatically includes at most 30 recent messages, 8 confirmed tagged
exchanges, and one compact summary, all under fixed character budgets. Provider
sessions are never resumed. Ordinary chat messages, participant rosters,
attachment metadata, and tool results are not archived by `s4imsg`.

## Operations

```sh
~/Library/Application\ Support/s4imsg/bin/s4imsg status
~/Library/Application\ Support/s4imsg/bin/s4imsg status --chats
~/Library/Application\ Support/s4imsg/bin/s4imsg doctor
~/Library/Application\ Support/s4imsg/bin/s4imsg stop
~/Library/Application\ Support/s4imsg/bin/s4imsg forget <opaque-chat-key>
~/Library/Application\ Support/s4imsg/bin/s4imsg uninstall
~/Library/Application\ Support/s4imsg/bin/s4imsg uninstall --purge --confirm-purge
```

`status` reports only operational counts, including silently rate-limited events,
and opaque chat keys. `forget` removes
tagged memory for one opaque key. Normal uninstall removes the service and
executable but retains private configuration and conversation state; the explicit
purge form removes all `s4imsg` state.

The first release processes one turn at a time, admits at most 32 active events
globally and 4 per chat, limits each runtime attempt to 10 minutes, and allows at
most one safe fallback. A send that might have completed is parked as ambiguous
and is never retried automatically. A runtime failure with observed or unknown
local tool activity is also parked rather than replayed.

## Upgrade

From the source checkout:

```sh
git pull --ff-only
bun install --frozen-lockfile
bun run src/cli.ts setup
```

Setup replaces the stable executable atomically and preserves configuration and
bounded memory. macOS may treat the replacement as a new privacy identity; run
`doctor` again and toggle stale Full Disk Access entries off and on if needed.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun run release:validate
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the
[release qualification matrix](docs/RELEASE_QUALIFICATION.md).

## License and trademarks

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This project is not affiliated with Apple, Anthropic, or OpenAI. iMessage,
Claude, and Codex are trademarks of their respective owners.
