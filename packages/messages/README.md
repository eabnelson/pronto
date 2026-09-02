# pronto-imessage

`pronto-imessage` is Pronto's reusable, in-process interface to local Apple Messages on macOS. It owns the `imsg` JSON-RPC child process, capability qualification, provider-event normalization, watch notifications, exact-chat reply routing, and local delivery outcomes. It does not launch agents, interpret activation tags, or grant access to consumer resources.

```ts
import { createProntoMessages } from "pronto-imessage";

const messages = createProntoMessages({
  imsgPath: "/opt/homebrew/bin/imsg",
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
      // Continue with live events and surface outcome.reason to the owner.
    }
  },
});
```

The package binds durable checkpoints to a fingerprint of the current Messages database. It restarts and resubscribes after provider failure, performs catch-up within row-count, age, and wall-clock limits, and reports privacy-safe recovery diagnostics. A send that may have reached the provider is returned as `ambiguous` and is never automatically replayed.

Every observed conversation carries a module-issued, versioned, tamper-evident reference with an expiry. History requires that exact reference plus an explicit message, row, byte, and RPC-call budget. Pagination continuations remain bound to the same conversation capability and database generation. They cannot be used to search another conversation.

Attachment metadata never exposes the Messages source path. Available attachments carry an expiring sealed reference. `materializeAttachment` revalidates the conversation, database generation, provider metadata, containment under the Messages attachments root, regular-file identity, size, and MIME evidence before copying bytes into owner-private scratch. The returned scratch file has an explicit `dispose()` lifecycle.

The package root exposes normalized, versioned provider facts and delivery outcomes. Raw JSON-RPC methods, database paths, and payloads remain internal. The package is standard ESM and supports current Node.js and Bun consumers; the standalone `pronto` CLI is one ordinary workspace consumer.
