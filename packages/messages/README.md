# pronto-imessage

`pronto-imessage` is Pronto's reusable, in-process interface to local Apple Messages on macOS. It owns the `imsg` JSON-RPC child process, capability qualification, provider-event normalization, watch notifications, exact-chat reply routing, and local delivery outcomes. It does not launch agents, interpret activation tags, or grant access to consumer resources.

```ts
import { createProntoMessages } from "pronto-imessage";

const messages = createProntoMessages({ imsgPath: "/opt/homebrew/bin/imsg" });
await messages.qualify();

const subscription = await messages.subscribe({
  onEvent: async (event) => {
    if (event.message.fromMe) return;
    await messages.reply({
      conversation: event.conversation,
      text: "Reply to this exact conversation",
    });
  },
});
```

The package root exposes normalized, versioned provider facts and delivery outcomes. Raw JSON-RPC methods and payloads remain internal. The package is standard ESM and supports current Node.js and Bun consumers; the standalone `pronto` CLI is one ordinary workspace consumer.
