# s4imsg

[![CI](https://github.com/eabnelson/s4imsg/actions/workflows/ci.yml/badge.svg)](https://github.com/eabnelson/s4imsg/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`s4imsg` is a small, local macOS bridge between iMessage and the Codex or Claude
Code CLI. Pick a tag such as `@helper`; when anyone uses it in an iMessage chat
you have already participated in, the bridge gives one bounded, one-shot turn to
your chosen local agent and sends one plain-text reply.

It is an independent MIT-licensed project. It does not require Studio Four,
create project folders per chat, select a model, or keep provider sessions alive.

## Before installing

The tag is not authentication. Every current or future participant in an eligible chat can invoke
your agent. `s4imsg` deliberately starts Claude Code and Codex with their approval
and sandbox checks bypassed, so the agent can read or modify files, run commands,
use configured tools anywhere your macOS user can access, and send conversation
material to its model provider. Untagged chat history and attachment content are
untrusted evidence, but can still influence the model. Only use `s4imsg` in chats
whose participants you trust, and tell them that tagged and nearby conversation
material may be processed by your model provider.

The working folder is context, not containment. Project instructions, hooks, and
MCP servers from a selected folder may also run with unrestricted access. Do not
switch a chat into a repository you do not trust.

## Requirements

- macOS 14 or newer with Messages signed in to iMessage
- [Bun 1.3.14](https://bun.sh/) for source installation
- [`imsg`](https://github.com/openclaw/imsg) 0.14 or a capability-compatible release
- At least one authenticated [Codex CLI](https://github.com/openai/codex) or
  [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/getting-started)

## Quick start

Install Bun and `imsg` if you do not already have them, then clone and run setup:

```sh
brew install oven-sh/bun/bun steipete/tap/imsg
git clone https://github.com/eabnelson/s4imsg.git
cd s4imsg
bun install --frozen-lockfile
bun run setup
```

Codex or Claude Code must already be installed and signed in before `bun run
setup`. Setup automatically detects both CLIs, lets you choose the primary and
optional fallback, and validates that every selected runtime can complete an
unattended tool call before installing anything.

The ordinary `imsg` read, watch, and text-send path is sufficient. `s4imsg` does
not require disabling System Integrity Protection or enabling `imsg`'s private
IMCore bridge.

Setup asks for:

1. A tag with or without the leading `@`; the default is `@s4`. The name must
   contain 1-32 letters, numbers, underscores, or hyphens.
2. A primary runtime when both Codex and Claude Code are installed.
3. Whether to use the other runtime as a fallback.
4. A default working folder (`~/s4imsg` by default). Existing folders are never
   cleared or chmodded and must be confirmed before reuse.
5. Explicit typed acceptance of the unrestricted trust model above.

Setup then performs one temporary noninteractive file-tool probe per selected
runtime. This uses the runtime's existing account, default model, user
configuration, hooks, and tools. `s4imsg` supplies
`--dangerously-skip-permissions` to Claude Code and
`--dangerously-bypass-approvals-and-sandbox` to Codex so an unattended turn can
never stall at an approval prompt.

Each chat starts in the setup folder and remembers its own active folder. A tagged
request such as `@s4 use /Users/me/Studio/my-project` switches that turn and, once
the confirmation reply is delivered, future turns in that chat. If you describe a
project without a path, the agent can offer numbered directory choices; reply with
a number in the next tagged message to confirm one.

After qualification, setup compiles a stable executable under
`~/Library/Application Support/s4imsg/`, writes an owner-only configuration, and
installs the `dev.s4imsg.agent` user LaunchAgent. It finishes by printing the
exact permission, `doctor`, and `status` steps for that Mac.

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
S4IMSG="$HOME/Library/Application Support/s4imsg/bin/s4imsg"
"$S4IMSG" doctor
"$S4IMSG" status
```

Wait for `doctor` to finish; its runtime probes can take around a minute. A
healthy listener reports `listener running`, `database ready`, and `daemon
ready`. `doctor` cannot test Messages Automation without sending a message, so
complete the [live test-chat checklist](docs/LIVE_SMOKE.md) once.

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

Messages sent to your own iMessage address appear in the local database as both
an outgoing message and an inbound mirror. `s4imsg` automatically correlates the
inbound mirror with its immediately preceding outgoing message and accepts only
the outgoing copy. This requires no identity setting and stores no iMessage
address. Ordinary one-to-one and group chats still accept tags from every
participant.

Each turn automatically includes at most 30 recent messages, 8 confirmed tagged
exchanges, and one compact summary, all under fixed character budgets. Provider
sessions are never resumed. Ordinary chat messages, participant rosters,
attachment metadata, and tool results are not archived by `s4imsg`.

## Operations

```sh
S4IMSG="$HOME/Library/Application Support/s4imsg/bin/s4imsg"
"$S4IMSG" status
"$S4IMSG" status --chats
"$S4IMSG" doctor
"$S4IMSG" stop
"$S4IMSG" forget <opaque-chat-key>
"$S4IMSG" uninstall
"$S4IMSG" uninstall --purge --confirm-purge
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

## Troubleshooting

### `daemon failed` immediately after setup

macOS can retain the permission record for a previous build while denying the
new executable. In Full Disk Access, remove the existing `s4imsg` entry, add the
exact installed executable again, and enable it. Press Command-Shift-G in the
file picker and paste:

```text
~/Library/Application Support/s4imsg/bin/s4imsg
```

Then restart and check the service:

```sh
/bin/launchctl kickstart -k "gui/$(id -u)/dev.s4imsg.agent"
sleep 3
"$HOME/Library/Application Support/s4imsg/bin/s4imsg" status
```

### No reply arrives

- Confirm the message is iMessage, not SMS or RCS.
- Confirm this Mac owner previously sent a message in that chat.
- Run `doctor` and resolve every failed check; degraded
  `messages-send-automation` is expected until the first real send.
- Open Messages once and approve its Automation prompt if macOS presents one.
- Check `~/Library/Logs/s4imsg/daemon.log`; logs contain operational states, not
  conversation content.

### A self-chat appears duplicated

Messages displays one self-chat message as an incoming and outgoing pair. That
pair is expected. Two reply pairs indicate two agent sends and should be
reported as a bug.

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
