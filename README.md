# Pronto

[![CI](https://github.com/eabnelson/pronto/actions/workflows/ci.yml/badge.svg)](https://github.com/eabnelson/pronto/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`pronto` is a small, local macOS bridge between Apple Messages and the Codex or
Claude Code CLI. Create as many tags as you want, such as `@helper`, `@plan`, or
`@research`. When anyone uses one in an iMessage or RCS chat you have already
participated in, the bridge gives one bounded, one-shot turn to your chosen
local agent and sends one plain-text reply.

Each reply starts with the triggering tag name on its own line, so conversations
using several tags make it clear which agent identity answered.

It is an independent MIT-licensed project. It does not require Studio Four,
create project folders per chat, select a model, or keep provider sessions alive.

The repository is a small workspace. [`pronto-imessage`](packages/messages) is
the reusable Apple Messages module, and the standalone [`pronto`](packages/cli)
CLI consumes that package through the same public interface available to other
products. Pronto owns provider mechanics; consumers own activation,
authorization, and product-specific state.

## Before installing

Tags are not authentication. Every current or future participant in an eligible chat can invoke
your agent. `pronto` deliberately starts Claude Code and Codex with their approval
and sandbox checks bypassed, so the agent can read or modify files, run commands,
use configured tools anywhere your macOS user can access, and send conversation
material to its model provider. Untagged chat history and attachment content are
untrusted evidence, but can still influence the model. Only use `pronto` in chats
whose participants you trust, and tell them that tagged and nearby conversation
material may be processed by your model provider.

The working folder is context, not containment. Project instructions, hooks, and
MCP servers from a selected folder may also run with unrestricted access. Do not
switch a chat into a repository you do not trust.

## Requirements

- macOS 14 or newer with Messages signed in to iMessage
- For RCS, an iPhone and carrier configuration that makes the RCS conversation
  available in Messages on the Mac
- [Bun 1.3.14](https://bun.sh/) only for development from source
- [`imsg`](https://github.com/openclaw/imsg) 0.15.0
- At least one authenticated [Codex CLI](https://github.com/openai/codex) or
  [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/getting-started)

## Quick start

Install `imsg`, download the signed binary for your Mac, verify its permanent
Apple identity, and run setup:

```sh
brew install steipete/tap/imsg
PRONTO_INSTALL_DIR="$(mktemp -d)" || exit 1
case "$(uname -m)" in
  arm64) PRONTO_TARGET="darwin-arm64" ;;
  x86_64) PRONTO_TARGET="darwin-x64" ;;
  *) echo "Unsupported Mac architecture" >&2; exit 1 ;;
esac
PRONTO_CANDIDATE="$PRONTO_INSTALL_DIR/pronto"
curl --fail --location --proto '=https' --tlsv1.2 \
  "https://github.com/eabnelson/pronto/releases/latest/download/pronto-$PRONTO_TARGET" \
  --output "$PRONTO_CANDIDATE" || exit 1
chmod 700 "$PRONTO_CANDIDATE"
codesign --verify --strict \
  -R='identifier "dev.pronto.cli" and anchor apple generic and certificate leaf[subject.OU] = "9YCNUWK84C"' \
  "$PRONTO_CANDIDATE" || exit 1
"$PRONTO_CANDIDATE" setup
unlink "$PRONTO_CANDIDATE"
rmdir "$PRONTO_INSTALL_DIR"
```

Codex or Claude Code must already be installed and signed in before setup.
Setup automatically detects both CLIs, lets you choose the primary and
optional fallback, and validates that every selected runtime can complete an
unattended tool call before installing anything.

The ordinary `imsg` read, watch, and text-send path is sufficient. `pronto` does
not require disabling System Integrity Protection or enabling `imsg`'s private
IMCore bridge.

Setup asks for:

1. One or more comma-separated tags, with or without the leading `@`; the
   default is `@s4`. Each name must contain 1-32 letters, numbers, underscores,
   or hyphens.
2. A primary runtime when both Codex and Claude Code are installed.
3. Whether to use the other runtime as a fallback.
4. A default working folder (`~/pronto` by default). Existing folders are never
   cleared or chmodded and must be confirmed before reuse.
5. Explicit typed acceptance of the unrestricted trust model above.

Setup then performs one temporary noninteractive file-tool probe per selected
runtime. This uses the runtime's existing account, default model, user
configuration, hooks, and tools. `pronto` supplies
`--dangerously-skip-permissions` to Claude Code and
`--dangerously-bypass-approvals-and-sandbox` to Codex so an unattended turn can
never stall at an approval prompt.

Each chat starts in the setup folder and remembers its own active folder. A tagged
request such as `@s4 use /Users/me/Studio/my-project` switches that turn and, once
the confirmation reply is delivered, future turns in that chat. If you describe a
project without a path, the agent can offer numbered directory choices; reply with
a number in the next tagged message to confirm one.

After qualification, setup compiles a stable executable under
`~/Library/Application Support/pronto/`, writes an owner-only configuration, and
installs the `dev.pronto.agent` user LaunchAgent. It asks the owner to grant Full
Disk Access to that exact installed executable, verifies the installed identity,
and reports success only after the new listener is healthy.

Source setup replaces Bun's embedded macOS signature with an ad-hoc signature so
the compiled executable can launch on supported macOS versions. If you have a
stable code-signing identity and want Full Disk Access to survive recompilation,
set `PRONTO_CODESIGN_IDENTITY` to that identity before running setup. The value is
passed directly to `/usr/bin/codesign`; it is never evaluated by a shell.

Official release binaries use the permanent `dev.pronto.cli` Developer ID
identity for Apple Team `9YCNUWK84C`, Hardened Runtime, a secure timestamp, and
Apple notarization. Moving from a source-built/ad-hoc installation to the first
official signed release requires one final Full Disk Access re-grant. Later
official updates preserve the installed path and designated requirement.

## macOS permissions

In System Settings → Privacy & Security:

- Grant Full Disk Access to the installed `pronto` executable so its supervised
  `imsg rpc` child can read `~/Library/Messages/chat.db`.
- Allow Messages automation when macOS prompts during the first outbound smoke
  test. The approval belongs to the installed executable's process context.
- If setup or a manual `imsg` check runs from Terminal or another parent app,
  that app may also need Full Disk Access.

After installation, run:

```sh
PRONTO="$HOME/Library/Application Support/pronto/bin/pronto"
"$PRONTO" doctor
"$PRONTO" status
```

Wait for `doctor` to finish; its runtime probes can take around a minute. A
healthy listener reports `listener running`, `database ready`, and `daemon
ready`. `doctor` cannot test Messages Automation without sending a message, so
complete the [live test-chat checklist](docs/LIVE_SMOKE.md) once.

## Use

Send a text message using any configured tag:

```text
@helper summarize the decision and suggest the next step
```

The message must be iMessage or RCS, not SMS, and the Mac owner must previously
have sent at least one message in that chat. Tags are case-insensitive. Reactions,
polls, and attachment-only messages do not activate the agent, but the agent can
query supported reactions, polls, participants, message details, and attachment
metadata from the current chat during an active turn. Attachment bytes are never
copied into bridge storage; a verified local attachment path may be returned so
the agent can inspect it with its normal file tools.

Messages sent to your own iMessage address appear in the local database as both
an outgoing message and an inbound mirror. `pronto` automatically correlates the
inbound mirror with its immediately preceding outgoing message and accepts only
the outgoing copy. This requires no identity setting and stores no iMessage
address. Ordinary one-to-one and group chats still accept tags from every
participant.

Each turn automatically includes at most 30 recent messages, 8 confirmed tagged
exchanges, and one compact summary, all under fixed character budgets. Provider
sessions are never resumed. Ordinary chat messages, participant rosters,
attachment metadata, and tool results are not archived by `pronto`.

## Operations

```sh
PRONTO="$HOME/Library/Application Support/pronto/bin/pronto"
"$PRONTO" status
"$PRONTO" status --chats
"$PRONTO" doctor
"$PRONTO" tags
"$PRONTO" tags add @plan
"$PRONTO" tags remove @plan
"$PRONTO" update --check
"$PRONTO" update
"$PRONTO" stop
"$PRONTO" forget <opaque-chat-key>
"$PRONTO" uninstall
"$PRONTO" uninstall --purge --confirm-purge
```

Tag changes are normalized, deduplicated, saved atomically, and applied by
restarting the background listener. At least one tag must remain configured. If
one message contains two different configured tags, `pronto` ignores it rather
than choosing an activation ambiguously.

`status` reports only operational counts, including silently rate-limited events,
and opaque chat keys. `forget` removes
tagged memory for one opaque key. Normal uninstall removes the service and
executable but retains private configuration and conversation state; the explicit
purge form removes all `pronto` state.

The first release processes one turn at a time, admits at most 32 active events
globally and 4 per chat, limits each runtime attempt to 10 minutes, and allows at
most one safe fallback. A send that might have completed is parked as ambiguous
and is never retried automatically. A runtime failure with observed or unknown
local tool activity is also parked rather than replayed.

## Upgrade

Official installations update automatically every six hours. Check or update
immediately with `pronto update --check` or `pronto update`. The updater verifies
the signed manifest, artifact digest, and Apple identity, drains the listener,
restarts it, and rolls back unless the new listener becomes healthy.

Source installations remain a development workflow:

```sh
git pull --ff-only
bun install --frozen-lockfile
bun run packages/cli/src/cli.ts setup
```

Source setup replaces the stable executable atomically and preserves
configuration and bounded memory, but its default ad-hoc signature has a new
privacy identity on every build. Use source setup only for development. Move to
the first official release by downloading and verifying the signed candidate as
shown in Quick start, then run `"$PRONTO_CANDIDATE" update --migrate-signing`.
Re-grant Full Disk Access once and use automatic signed updates thereafter. See
[Signed releases and automatic updates](docs/UPDATES.md).

## Troubleshooting

### `daemon failed` immediately after setup

macOS can retain the permission record for a previous build while denying the
new executable. In Full Disk Access, remove the existing `pronto` entry, add the
exact installed executable again, and enable it. Press Command-Shift-G in the
file picker and paste:

```text
~/Library/Application Support/pronto/bin/pronto
```

Then restart and check the service:

```sh
/bin/launchctl kickstart -k "gui/$(id -u)/dev.pronto.agent"
sleep 3
"$HOME/Library/Application Support/pronto/bin/pronto" status
```

### No reply arrives

- Confirm the message is iMessage or RCS, not SMS.
- Confirm this Mac owner previously sent a message in that chat.
- Run `doctor` and resolve every failed check; degraded
  `messages-send-automation` is expected until the first real send.
- Open Messages once and approve its Automation prompt if macOS presents one.
- Check `~/Library/Logs/pronto/daemon.log`; logs contain operational states, not
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
