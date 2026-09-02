# Live test-chat checklist

Use a dedicated iMessage conversation whose participants know the test is
happening. A live smoke sends real conversation material to the selected model
provider and sends real iMessages; it is never run by CI.

## Core reply and permissions

1. Confirm Messages is signed in and the owner has already sent a message in the
   test chat.
2. Run setup and confirm it offers `~/pronto`, asks before reusing an existing
   folder, and presents the
   unrestricted trust disclosure before the runtime probe.
3. Confirm the probe completes without a Claude Code or Codex approval prompt.
4. Run `~/Library/Application\ Support/pronto/bin/pronto doctor`. Resolve failed checks. A degraded
   `messages-send-automation` check is expected until this smoke succeeds.
5. Run `~/Library/Application\ Support/pronto/bin/pronto status` and confirm the listener is `running`.
6. Send `<tag> reply with exactly: pronto smoke ok` in the test chat.
7. Approve the macOS Messages Automation prompt for the installed `pronto`
   executable if it appears.
8. Confirm exactly one plain-text reply arrives and it contains
   `pronto smoke ok`.
9. Wait one minute and confirm the sent reply did not trigger an echo-loop turn.

## Self-chat mirror handling

1. Re-run setup; self-chat handling should require no question or address entry.
2. Re-grant Full Disk Access if macOS treats the rebuilt executable as a new
   identity, then confirm `pronto status` reports `daemon ready`.
3. Send one new tagged message to yourself and confirm the agent runs once and
   sends one reply, even though Messages displays incoming and outgoing copies.
4. In a different eligible chat, have another participant send a tagged message
   and confirm their request still runs once.

## Per-chat working folders

1. In one test chat, send a tagged `use /absolute/path/to/project` request and
   confirm that turn operates there.
2. Send a later tagged request in that chat and confirm it retains the folder.
3. Use another test chat and confirm it still starts in the setup default.
4. Ask the first chat to find a project without giving a path. Confirm it offers
   numbered choices and does not switch until the next tagged message selects one.

## Bounded conversation context

1. Send an untagged message containing a synthetic fact, such as
   `The synthetic launch color is amber.`
2. Send `<tag> what is the synthetic launch color?` and confirm the answer uses
   the recent untagged message.
3. Send `<tag> remember that the synthetic release owner is Rowan.`
4. Exchange enough ordinary messages to move that request out of the immediate
   recent window.
5. Send `<tag> who is the synthetic release owner?` and confirm the answer uses
   prior tagged memory.

## Recovery and inspection

1. Run `~/Library/Application\ Support/pronto/bin/pronto status --chats`; confirm it prints only opaque `c_...` keys and
   counts, never handles or message text.
2. Stop and restart through `bun run packages/cli/src/cli.ts setup`, then send one new tagged
   request. Confirm no old request is replayed.
3. Run `~/Library/Application\ Support/pronto/bin/pronto forget <opaque-chat-key>`, then confirm the prior tagged fact is no
   longer available unless it is still present in recent Messages history.
4. Inspect `~/Library/Logs/pronto/daemon.log` and confirm it contains no message
   text, participant handles, chat identifiers, provider output, or attachment
   paths.

Record the date, macOS version, `imsg --version`, selected runtime versions, and
pass/fail result in `docs/RELEASE_QUALIFICATION.md`. Never record real chat
content or participant identifiers.
