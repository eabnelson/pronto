# Live test-chat checklist

Use a dedicated iMessage conversation whose participants know the test is
happening. A live smoke sends real conversation material to the selected model
provider and sends real iMessages; it is never run by CI.

## Core reply and permissions

1. Confirm Messages is signed in and the owner has already sent a message in the
   test chat.
2. Run `~/Library/Application\ Support/s4imsg/bin/s4imsg doctor`. Resolve failed checks. A degraded
   `messages-send-automation` check is expected until this smoke succeeds.
3. Run `~/Library/Application\ Support/s4imsg/bin/s4imsg status` and confirm the listener is `running`.
4. Send `<tag> reply with exactly: s4imsg smoke ok` in the test chat.
5. Approve the macOS Messages Automation prompt for the installed `s4imsg`
   executable if it appears.
6. Confirm exactly one plain-text reply arrives and it contains
   `s4imsg smoke ok`.
7. Wait one minute and confirm the sent reply did not trigger an echo-loop turn.

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

1. Run `~/Library/Application\ Support/s4imsg/bin/s4imsg status --chats`; confirm it prints only opaque `c_...` keys and
   counts, never handles or message text.
2. Stop and restart through `bun run src/cli.ts setup`, then send one new tagged
   request. Confirm no old request is replayed.
3. Run `~/Library/Application\ Support/s4imsg/bin/s4imsg forget <opaque-chat-key>`, then confirm the prior tagged fact is no
   longer available unless it is still present in recent Messages history.
4. Inspect `~/Library/Logs/s4imsg/daemon.log` and confirm it contains no message
   text, participant handles, chat identifiers, provider output, or attachment
   paths.

Record the date, macOS version, `imsg --version`, selected runtime versions, and
pass/fail result in `docs/RELEASE_QUALIFICATION.md`. Never record real chat
content or participant identifiers.
