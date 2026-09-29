import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagesEvent } from "pronto-imessage";
import type {
  ProntoWhatsapp,
  WhatsappConversationReference,
  WhatsappDeliveryOutcome,
  WhatsappEvent,
  WhatsappHealth,
  WhatsappMessageKind,
} from "pronto-whatsapp";
import { activatedRequest } from "../../packages/cli/src/activation";
import type { ChannelActivation, ChannelConnectionHealth } from "../../packages/cli/src/channels/types";
import {
  WhatsappChannel,
  whatsappActivation,
  whatsappAttachmentId,
} from "../../packages/cli/src/whatsapp/channel";
import { formatWhatsappReplyText } from "../../packages/cli/src/whatsapp/reply-format";

const CHAT = "15555550100@s.whatsapp.net";
const reference: WhatsappConversationReference = {
  chatJid: CHAT,
  expiresAt: "2099-01-01T00:00:00.000Z",
  provider: "whatsapp",
  token: "signed-reference",
  version: 1,
};

interface Case {
  readonly fromMe?: boolean;
  readonly kind?: "message" | "reaction" | "poll";
  readonly ownerParticipated?: boolean;
  readonly text?: string | null;
}

function whatsappEvent(input: Case & { readonly id?: string } = {}): WhatsappEvent {
  return {
    conversation: reference,
    conversationFacts: {
      isGroup: false,
      ownerParticipated: input.ownerParticipated ?? true,
      selfChat: false,
    },
    message: {
      fromMe: input.fromMe ?? false,
      kind: (input.kind ?? "message") as WhatsappMessageKind,
      media: null,
      occurredAt: "2026-09-29T21:07:27.000Z",
      providerMessageId: input.id ?? "3B0E917703046C6AAFD7",
      replyToProviderMessageId: null,
      sender: input.fromMe === true ? "14149407496@s.whatsapp.net" : CHAT,
      senderName: null,
      text: input.text === undefined ? "@helper do this" : input.text,
    },
    origin: "live",
    provider: "whatsapp",
    version: 1,
  };
}

function imessageEvent(input: Case): MessagesEvent {
  return {
    conversation: {
      chatId: 42,
      expiresAt: "2099-01-01T00:00:00.000Z",
      provider: "apple-messages",
      token: "conversation-token",
      version: 1,
    },
    conversationFacts: { ownerParticipated: input.ownerParticipated ?? true, service: "iMessage" },
    message: {
      attachments: [],
      destinationCallerId: null,
      fromMe: input.fromMe ?? false,
      kind: input.kind ?? "message",
      occurredAt: "2026-09-29T21:07:27.000Z",
      providerMessageId: "message-guid",
      reaction: null,
      replyToProviderMessageId: null,
      replyToText: null,
      rowId: 101,
      selfChatMirror: false,
      sender: "+15555550100",
      service: "iMessage",
      text: input.text === undefined ? "@helper do this" : input.text,
      urlPreview: false,
    },
    provider: "apple-messages",
    version: 1,
  };
}

describe("WhatsApp activation follows the iMessage rules", () => {
  const tags = ["@helper", "@plan"];
  const cases: Array<[string, Case]> = [
    ["a participant's tagged message", {}],
    ["the owner's own tagged message", { fromMe: true }],
    ["a chat the owner never joined", { ownerParticipated: false }],
    ["an untagged message", { text: "no tag here" }],
    ["two different tags", { text: "@helper and @plan" }],
    ["a bare tag", { text: "@helper" }],
    ["a tag inside a word", { text: "email@helper.com" }],
    ["a tag with punctuation", { text: "(@helper) summarize, please." }],
    ["a reaction", { kind: "reaction" }],
    ["a poll", { kind: "poll" }],
    ["a message without text", { text: null }],
  ];

  for (const [name, input] of cases) {
    test(name, () => {
      const imessage = activatedRequest(imessageEvent(input), tags);
      const whatsapp = whatsappActivation(whatsappEvent(input), tags);
      expect(whatsapp === null).toBe(imessage === null);
      expect(whatsapp?.request).toBe(imessage?.request);
      expect(whatsapp?.activationTag).toBe(imessage?.activationTag);
      expect(whatsapp?.isFromMe).toBe(imessage?.isFromMe);
    });
  }

  test("addresses the chat and keeps the message to quote", () => {
    expect(whatsappActivation(whatsappEvent(), ["@helper"])).toEqual({
      activationTag: "@helper",
      chat: { channel: "whatsapp", id: CHAT },
      conversation: {
        ...reference,
        quote: { providerMessageId: "3B0E917703046C6AAFD7", sender: CHAT },
      },
      isFromMe: false,
      providerGuid: `whatsapp:${CHAT}:3B0E917703046C6AAFD7`,
      request: "do this",
    });
  });
});

class FakeWhatsapp implements ProntoWhatsapp {
  events: WhatsappEvent[] = [];
  health: WhatsappHealth[] = [];
  outcome: WhatsappDeliveryOutcome = { providerMessageId: "3EB0SENT", status: "confirmed" };
  replies: Array<Parameters<ProntoWhatsapp["reply"]>[0]> = [];
  typing: boolean[] = [];
  historyInput: Parameters<ProntoWhatsapp["history"]>[0] | undefined;
  readonly #terminated = Promise.withResolvers<void>();
  readonly presence = {
    setTyping: async (_conversation: WhatsappConversationReference, typing: boolean) => {
      this.typing.push(typing);
    },
  };

  unlinkDevice(): void {
    this.#terminated.resolve();
  }

  async qualify() {
    return { linkedJid: "14149407496@s.whatsapp.net", status: "ready" as const, wacliVersion: "0.19.0" };
  }
  async subscribe(input: Parameters<ProntoWhatsapp["subscribe"]>[0]) {
    for (const health of this.health) await input.onHealth?.(health);
    for (const event of this.events) await input.onEvent(event);
    return { close: async () => undefined, terminated: this.#terminated.promise };
  }
  async history(input: Parameters<ProntoWhatsapp["history"]>[0]) {
    this.historyInput = input;
    return [whatsappEvent({ id: "EARLIER", text: "context" })];
  }
  async reply(input: Parameters<ProntoWhatsapp["reply"]>[0]) {
    this.replies.push(input);
    return this.outcome;
  }
  attachmentRequests: Array<Parameters<ProntoWhatsapp["materializeAttachment"]>[0]> = [];
  disposed = 0;
  async materializeAttachment(input: Parameters<ProntoWhatsapp["materializeAttachment"]>[0]) {
    this.attachmentRequests.push(input);
    const directory = await mkdtemp(join(tmpdir(), "pronto-wa-attachment-"));
    const path = join(directory, "photo.jpg");
    await writeFile(path, "jpeg bytes");
    return {
      dispose: async () => {
        this.disposed += 1;
        await rm(directory, { force: true, recursive: true });
      },
      mimeType: "image/jpeg",
      name: "photo.jpg",
      path,
      sha256: "0".repeat(64),
      sizeBytes: 10,
    };
  }
  async *link() {}
  async unlink() {}
  async close() {}
}

describe("WhatsApp channel", () => {
  test("replies quoted in the same chat and maps delivery outcomes", async () => {
    const whatsapp = new FakeWhatsapp();
    whatsapp.events = [whatsappEvent()];
    const channel = new WhatsappChannel(whatsapp);
    const activations: ChannelActivation[] = [];
    const watch = await channel.watch({
      onActivation: (activation) => { activations.push(activation); },
      tags: ["@helper"],
    });
    await watch.close();

    const activation = activations[0]!;
    const text = channel.formatReply(activation.activationTag, "Done.");
    expect(text).toBe("*Helper*\nDone.");
    expect(await channel.sendText(activation.chat, text, activation.conversation)).toEqual({
      disposition: "confirmed",
      guid: "3EB0SENT",
    });
    expect(whatsapp.replies).toEqual([{
      conversation: reference,
      quote: { providerMessageId: "3B0E917703046C6AAFD7", sender: CHAT },
      text: "*Helper*\nDone.",
    }]);
    whatsapp.outcome = { status: "ambiguous" };
    expect(await channel.sendText(activation.chat, text, activation.conversation))
      .toEqual({ disposition: "ambiguous" });
    whatsapp.outcome = { reason: "store locked", retryable: true, status: "failed" };
    expect(await channel.sendText(activation.chat, text, activation.conversation))
      .toEqual({ disposition: "failed", retrySafe: true });
    await expect(channel.sendText({ channel: "whatsapp", id: "other@s.whatsapp.net" }, text, activation.conversation))
      .rejects.toThrow("scope is unavailable");
  });

  test("never activates on its own echoed reply", async () => {
    const whatsapp = new FakeWhatsapp();
    whatsapp.events = [whatsappEvent({ fromMe: true, text: "*Helper*\n@helper done" })];
    const channel = new WhatsappChannel(whatsapp, { matchesOutboundEcho: () => true });
    const watch = await channel.watch({
      onActivation: () => { throw new Error("echo must not activate"); },
      tags: ["@helper"],
    });
    await watch.close();
  });

  test("reads bounded history and typing only for observed chats", async () => {
    const whatsapp = new FakeWhatsapp();
    whatsapp.events = [whatsappEvent()];
    const channel = new WhatsappChannel(whatsapp);
    const chat = { channel: "whatsapp", id: CHAT } as const;
    await expect(channel.currentChat.history(chat, 10)).rejects.toThrow("scope is unavailable");
    await channel.watch({ onActivation: () => undefined, tags: ["@helper"] });

    expect(await channel.recentMessages(chat, 500)).toEqual([expect.objectContaining({
      fromMe: false,
      messageGuid: "EARLIER",
      service: "WhatsApp",
      text: "context",
    })]);
    expect(whatsapp.historyInput?.limit).toBe(100);
    expect(await channel.currentChat.details(chat)).toEqual({
      is_group: false,
      owner_participated: true,
      provider: "whatsapp",
      self_chat: false,
    });
    await channel.setTyping(chat, reference, true);
    await channel.setTyping(chat, reference, false);
    expect(whatsapp.typing).toEqual([true, false]);
  });

  test("reports an unlinked device without ending the listener", async () => {
    const whatsapp = new FakeWhatsapp();
    whatsapp.health = [{ state: "connected" }, { reason: "keepalive", state: "reconnecting" }];
    const channel = new WhatsappChannel(whatsapp);
    const health: ChannelConnectionHealth[] = [];
    const watch = await channel.watch({
      onActivation: () => undefined,
      onHealth: (value) => { health.push(value); },
      tags: ["@helper"],
    });
    whatsapp.unlinkDevice();
    await Bun.sleep(0);
    expect(health).toEqual([
      { state: "connected" },
      { reason: "keepalive", state: "reconnecting" },
      { state: "needs_link" },
    ]);
    expect(await Promise.race([watch.terminated.then(() => "ended"), Bun.sleep(10).then(() => "running")]))
      .toBe("running");
  });

  test("lets the agent open a tagged photo through the current-chat tool", async () => {
    const photo: WhatsappEvent = {
      ...whatsappEvent({ id: "PHOTO", text: "@helper what is in this photo?" }),
      message: {
        ...whatsappEvent({ id: "PHOTO", text: "@helper what is in this photo?" }).message,
        media: { caption: "@helper what is in this photo?", filename: null, mimeType: "image/jpeg", sizeBytes: 10, type: "image" },
      },
    };
    const whatsapp = new FakeWhatsapp();
    whatsapp.events = [photo];
    whatsapp.history = async () => [photo];
    const channel = new WhatsappChannel(whatsapp);
    const activations: ChannelActivation[] = [];
    await channel.watch({ onActivation: (activation) => { activations.push(activation); }, tags: ["@helper"] });
    expect(activations[0]?.request).toBe("what is in this photo");

    const chat = { channel: "whatsapp", id: CHAT } as const;
    const history = await channel.currentChat.history(chat, 10) as { messages: Array<{ attachments: Array<Record<string, unknown>> }> };
    const attachmentId = whatsappAttachmentId(CHAT, "PHOTO");
    expect(history.messages[0]?.attachments).toEqual([{
      attachmentId,
      available: true,
      mimeType: "image/jpeg",
      name: "image attachment",
      sizeBytes: 10,
    }]);

    expect(await channel.currentChat.attachment(chat, "PHOTO", "wrong-id")).toBeNull();
    const opened = await channel.currentChat.attachment(chat, "PHOTO", attachmentId);
    expect(opened).toMatchObject({ attachmentId, messageGuid: "PHOTO", name: "photo.jpg" });
    expect(await readFile(opened!.path, "utf8")).toBe("jpeg bytes");
    expect(whatsapp.attachmentRequests).toEqual([{
      conversation: reference,
      maxBytes: 20 * 1024 * 1024,
      providerMessageId: "PHOTO",
    }]);
    await channel.close();
    expect(whatsapp.disposed).toBe(1);
  });

  test("formats a bold heading like the iMessage reply heading", () => {
    expect(formatWhatsappReplyText("@studio_four-4", "")).toBe("*Studio_four-4*");
  });
});
