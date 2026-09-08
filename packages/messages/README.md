# pronto-imessage

`pronto-imessage` is Pronto's reusable, in-process interface to local Apple Messages on macOS. It owns the `imsg` JSON-RPC child process, capability qualification, provider-event normalization, watch notifications, exact-chat reply routing, and local delivery outcomes. It does not launch agents, decide which messages may activate them, or grant access to consumer resources.

```ts
import { createProntoMessages } from "pronto-imessage";

const messages = createProntoMessages({
  imsgPath: "/opt/homebrew/bin/imsg",
  // Use an owner-private stable value of at least 32 bytes when queued work
  // must retain an exact conversation reference across a process restart.
  referenceKey: process.env.PRONTO_MESSAGES_REFERENCE_KEY,
  statePath: "/private/application-state/provider-state.json",
});
await messages.qualify();

const subscription = await messages.subscribe({
  onEvent: async (event) => {
    if (event.message.fromMe) return;
    const page = await messages.history({
      conversation: event.conversation,
      budget: {
        maxMessages: 30,
        maxRows: 30,
        maxBytes: 2 * 1024 * 1024,
        maxRpcCalls: 1,
      },
      mode: "recent",
      includeReactions: true,
    });
    await messages.reply({
      conversation: event.conversation,
      text: `Reply to this exact conversation (${page.messages.length} context rows)`,
    });
  },
  onRecovery: async (outcome) => {
    if (outcome.status === "degraded") {
      // Surface outcome.reason; retrying-checkpoint is not ready for live events.
    }
  },
});
```

A consumer migrating an older provider checkpoint can call `adoptCheckpoint`
after qualification and before subscribing. The versioned candidate includes
the prior database generation, row, and provider message ID. Pronto accepts it
only when the database identity matches and that exact pre-cutover witness is
still present; otherwise it returns a structured rejection. An existing Pronto
checkpoint is always preserved.

The package binds durable checkpoints to a fingerprint of the current Messages database. It restarts and resubscribes after provider failure, performs catch-up within row-count, age, and wall-clock limits, skips stale recovery rows without hiding newer eligible rows, and rejects stale live notifications. The recovery and live age limits are independently configurable with `recoveryLimits.maxAgeMs` and `recoveryLimits.maxLiveAgeMs`. A send that may have reached the provider is returned as `ambiguous` and is never automatically replayed.

`maxDurationMs` bounds each catch-up attempt. A duration timeout reports
`action: "retrying-checkpoint"` and retries from the durable checkpoint with
250 ms–30 s backoff instead of switching to future-only events. Completed rows
continue to consume the recovery row budget across those retries. Successful
recovery is reported only after watch subscription succeeds. Close cancels a
pending retry; row-limit and database-identity boundaries retain their explicit
live-only/fail-closed behavior. An in-flight consumer callback is awaited, not
concurrently replayed, before checkpoint recovery proceeds.

Every observed conversation carries a module-issued, versioned, tamper-evident reference with an expiry. References are process-local by default. A consumer with durable queued work can provide a stable owner-private `referenceKey` of at least 32 bytes; that permits an unexpired observed reference to be revalidated after restart without granting access to a different chat. Rotating the key invalidates outstanding references. History requires that exact reference plus an explicit message, row, byte, and RPC-call budget. Pagination continuations remain bound to the same conversation capability and database generation. They cannot be used to search another conversation.

When `conversationFacts.routing` is present, it contains the exact provider
conversation, account, destination, group, and roster facts jointly verified
from the anchored message and chat catalog. Consumers that require those facts
must fail closed when the optional routing projection is absent. Durable local
work can call `resolveConversation` with an already-authorized exact account ID
and conversation ID; the module performs only an exact bounded lookup and
returns a fresh scoped reference or `null`. It never exposes catalog browsing or
fuzzy/global search.

`event.message.destinationCallerId` preserves `imsg`'s message-level
`destination_caller_id` when present. It is the evidence for the local alias
used by that specific outbound row; `routing.destinationHandle` remains a
chat-level routing hint and must not be presented as message-level proof.

Attachment metadata never exposes the Messages source path. Available attachments carry an expiring sealed reference. `materializeAttachment` revalidates the conversation, database generation, provider metadata, containment under the Messages attachments root, regular-file identity, size, and MIME evidence before copying bytes into owner-private scratch. The returned scratch file has an explicit `dispose()` lifecycle.

`reply` optionally accepts one absolute, consumer-staged `filePath`. Routing,
submission ambiguity, and retry classification remain owned by this module;
the consumer remains responsible for authorizing and cleaning its staged file.

The package root exposes normalized, versioned provider facts and delivery outcomes. Raw JSON-RPC methods, database paths, and payloads remain internal. The package is standard ESM and supports current Node.js and Bun consumers; the standalone `pronto` CLI is one ordinary workspace consumer.

## Shared tag mechanics

The optional `pronto-imessage/tags` module contains pure text operations; importing
it does not open Messages or load the transport. This subpath is new development
work and is not available in the published 0.4.0 package.

```ts
import { matchTaggedMessage, normalizeTags } from "pronto-imessage/tags";

const tags = normalizeTags(["Olle", "@pronto"]);
// The consumer validates allowed syntax, ownership and count before accepting tags.
const match = matchTaggedMessage("@pronto say hey", tags);
// { status: "matched", tag: "@pronto", message: "say hey" }
```

`normalizeTag` trims, adds a missing `@`, and lowercases. `normalizeTags` also
deduplicates, retaining first-occurrence order. These functions deliberately do
not validate syntax or reject an empty configuration. A consumer requiring
ASCII input should validate before case folding, since some Unicode characters
lowercase to ASCII. Pronto's CLI keeps its existing syntax and nonempty-tag rules;
other consumers may retain their own compatible syntax.

`matchTaggedMessage` accepts already-validated candidates. It matches bounded
literal names case-insensitively, strips every occurrence of the one selected
candidate, and returns the configured spelling and cleaned message. A tag-only
message becomes `Help with this conversation.` Missing or ambiguous matches
return only a reason, never the ignored content. Multiple different configured
tags in a message are ambiguous. Duplicate candidates also stay ambiguous so
two bindings cannot silently claim one tag; do not deduplicate candidates from
different owners. `findTagRanges` exposes the same matching with UTF-16 offsets.

A match is not permission to run an agent, read a conversation, or send a reply.
Eligibility, mirror suppression, binding selection, permissions, signed admission
and delivery authorization remain the consumer's responsibility. Tags alone
never establish identity or authority.
