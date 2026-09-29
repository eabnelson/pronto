# pronto-whatsapp

`pronto-whatsapp` is Pronto's reusable, in-process interface to WhatsApp on macOS. It supervises the [`wacli`](https://github.com/openclaw/wacli) CLI as a linked device of the owner's own WhatsApp account. The module owns linking, qualification, the long-running `wacli sync` child, the loopback webhook receiver, event normalization, recovery sweeps, conversation-scoped history, and delivery outcomes for replies. It does not launch agents, interpret activation tags, or grant access to consumer resources.

> **Disclosure.** `wacli` speaks the unofficial WhatsApp Web multi-device protocol through [whatsmeow](https://github.com/tulir/whatsmeow). Neither `wacli`, whatsmeow, nor this package is affiliated with, endorsed by, or supported by WhatsApp or Meta. Automating a linked device may violate WhatsApp's Terms of Service and can lead to the account being restricted or banned. Use it only on an account you own, and at your own risk.

## Install

```sh
brew install openclaw/tap/wacli   # wacli 0.19.0 or newer
npm i pronto-whatsapp
```

## Link the account

```ts
import { createProntoWhatsapp } from "pronto-whatsapp";

const whatsapp = createProntoWhatsapp({
  wacliPath: "/opt/homebrew/bin/wacli",
  storeDir: "/private/application-state/whatsapp", // created with mode 0700
  statePath: "/private/application-state/whatsapp-state.json",
  referenceKey: process.env.PRONTO_WHATSAPP_REFERENCE_KEY!, // at least 32 characters
});

if ((await whatsapp.qualify()).status === "needs_link") {
  for await (const step of whatsapp.link()) {
    if (step.type === "qr") renderQr(step.code); // raw QR payload; scan in WhatsApp > Linked devices
    if (step.type === "failed") throw new Error(step.reason);
  }
}
```

`link({ phone: "+15551234567" })` pairs by phone number instead and yields a `pairing_code` step. Pass `signal` to cancel; aborting stops the `wacli auth` process. The iterator ends after `wacli` finishes its initial sync, so it is safe to `subscribe()` once it completes. `unlink()` ends any subscription and runs `wacli auth logout`.

## Answer tagged messages

```ts
const subscription = await whatsapp.subscribe({
  onEvent: async (event) => {
    const { message, conversation, conversationFacts } = event;
    if (message.kind !== "message" || !message.text?.startsWith("@s4 ")) return;
    if (!conversationFacts.selfChat && !conversationFacts.ownerParticipated) return;
    const context = await whatsapp.history({ conversation, limit: 30 });
    const outcome = await whatsapp.reply({
      conversation,
      quote: { providerMessageId: message.providerMessageId, sender: message.sender },
      text: `Done (${context.length} messages of context).`,
    });
    if (outcome.status === "ambiguous") {
      // It may have been sent. Never resend automatically.
    }
  },
  onHealth: (health) => console.log("whatsapp", health.state),
  onRecovery: (outcome) => {
    if (outcome.status === "degraded") console.warn("whatsapp recovery", outcome.reason);
  },
});
await subscription.terminated; // settles if WhatsApp unlinks the device
```

If the account is not linked when `subscribe()` is called, the returned subscription reports `needs_link` and its `terminated` promise is already settled. `terminated` also settles after `close()`. Do not await `close()` from inside `onEvent`: `close()` waits for the in-flight callback.

## What the module owns

- **The `wacli` session.** One `wacli sync --follow` child per subscription, restarted on unexpected exit with 250 ms–30 s backoff (reset after a healthy minute). `logged_out` reports health `needs_link`, stops the child without restarting, and settles `terminated`. `close()` interrupts the child, waits, then kills it, and awaits an in-flight `onEvent`.
- **The webhook receiver.** A loopback-only (`127.0.0.1`, ephemeral port) HTTP endpoint with a per-subscription secret. Every body is checked against `X-Wacli-Signature` with a constant-time comparison and capped at 1 MiB.
- **Normalization.** Status broadcasts, broadcast lists, and newsletters are dropped. Each message gets a `kind` (`message`, `reaction`, `edit`, `revoke`, `poll`, `call`, `unsupported`), text (or media caption), media metadata, a canonical sender (the linked account for `fromMe`), and conversation facts: `isGroup`, `selfChat` (the "Message yourself" chat), and `ownerParticipated` (the owner has sent at least one message in the chat).
- **Ordered, deduplicated delivery.** `onEvent` runs one at a time, in arrival order. `wacli` can post the same message twice; the module delivers each `(chat, message id)` once, using a bounded recently-delivered set stored in `statePath` (atomic write, mode 0600). Replies the module sends are recorded too, so they are not replayed as events.
- **Conversation scope.** Each event carries a signed `WhatsappConversationReference` that expires after `scopeLimits.ttlMs` (default 24 hours). `history`, `reply`, and `presence` accept only unexpired references signed with the same `referenceKey`; rotating the key invalidates them all.
- **Replies.** `reply` waits (up to 30 s) until the running sync is connected and has opened its send socket, then sends through it, quoting when asked. Messages to the self chat are sent with `--allow-self`. Outcomes are `confirmed` (with the provider message ID), `failed` with `retryable` when the connection was not ready, or `ambiguous` when the send may have reached WhatsApp (timeout, crash, unreadable output). Nothing is retried automatically.
- **Presence.** With `presence: true`, `presence.setTyping(conversation, typing)` shows or clears the typing indicator. It is best-effort and never throws for provider errors.

## What the consumer owns

Activation rules (tags, who may activate, whether `fromMe` or `recovered` events count), agent execution, the delivery journal, retry policy for `failed`/`ambiguous` outcomes, reply formatting, and the lifetime and secrecy of `storeDir`, `statePath`, and `referenceKey`. `storeDir` holds the WhatsApp session keys and the local message index; treat it like a password.

## Age limits and recovery

The defaults match `pronto-imessage`, so a consumer gets the same activation behavior on both apps.

- A live (webhook) message older than `recoveryLimits.maxLiveAgeMs` (default 5 minutes) when it arrives is not delivered live. It is remembered as undelivered so a recovery sweep can deliver it.
- Recovery sweeps run when a subscription starts, after `wacli` reports `offline_sync_completed`, and every 5 minutes while connected (covering dropped webhooks). A sweep reads messages newer than the watermark (the newest delivered timestamp) or the oldest undelivered message, bounded by `recoveryLimits.maxAgeMs` (default 24 hours) and `recoveryLimits.maxMessages` (default 500). Those messages are delivered with `origin: "recovered"`.
- `onRecovery` reports `recovered` with a count, or `degraded` with `sweep-limit` (more messages remain; the next sweep continues from the new watermark) or `sweep-failed` (the local index could not be read). Periodic sweeps report only when they find something or degrade.
- The watermark and delivered ids advance only after `onEvent` resolves. If `onEvent` throws, the message stays undelivered and a later sweep offers it again.
- The first subscription on a new `statePath` starts from now. It does not replay existing history.

## Notes

The package root exposes normalized, versioned provider facts and delivery outcomes. `wacli` commands, flags, webhook payloads, and store paths stay internal. Every child process is spawned with an argument array (no shell), with stdin closed, bounded output, and a timeout. The package is standard ESM for current Node.js and Bun consumers. It shares no runtime code with `pronto-imessage`.
