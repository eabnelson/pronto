import type { ProntoSlackProvider, SlackObservation, SlackScope } from "pronto-slack";
import { removeOneMatchedTag } from "../activation";
import { ChannelNeedsLinkError, type Channel, type ChannelActivation, type ChatAddress, type ChannelWatch, type SendDisposition } from "../channels/types";
import type { CurrentChatSource } from "../tools/broker";
import type { CurrentChatMessage } from "../imessage/event-adapter";

export function slackActivation(event: SlackObservation, tags: readonly string[]): ChannelActivation | null {
  if (!event.ownerParticipated) return null;
  const match = removeOneMatchedTag(event.message.text, tags);
  return match === null ? null : { ...match, chat: { channel: "slack", id: event.scope.id }, conversation: event.scope, isFromMe: event.fromMe, providerGuid: event.messageId };
}
export function inertSlackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/(^|[^\p{L}\p{N}\p{M}._@-])@(?=[A-Za-z0-9_-])/gu, "$1@\u200b");
}
function heading(tag: string): string { const name = tag.replace(/^@/, ""); return name.charAt(0).toUpperCase() + name.slice(1); }
function scope(value: unknown, chat: ChatAddress): SlackScope {
  const candidate = value as SlackScope | undefined;
  if (chat.channel !== "slack" || candidate?.provider !== "slack" || candidate.id !== chat.id || candidate.version !== 1 || typeof candidate.token !== "string") throw new Error("slack-scope-unavailable");
  return candidate;
}
export class SlackChannel implements Channel {
  readonly kind = "slack" as const;
  readonly conversationLabel = "Slack (this thread or DM timeline; text replies only)";
  readonly currentChat: CurrentChatSource;
  readonly #scopes = new Map<string, SlackScope>();
  constructor(readonly provider: ProntoSlackProvider, readonly diagnostics?: (sample: { origin: string; latencyMs?: number; recovery?: { status: string; reason?: string; messages: number; requests: number; bytes: number; durationMs: number } }) => void) {
    this.currentChat = {
      details: async (chat, conversation) => {
        const authority = scope(conversation ?? this.#scopes.get(chat.id), chat);
        if (!await provider.authorized(authority)) throw new Error("slack-scope-revoked");
        return { provider: "slack", owner_participated: true, scope: "current conversation only", files_supported: false };
      },
      history: async (chat, limit, conversation) => ({ messages: await this.recentMessages(chat, limit, conversation), has_more: true }),
      attachment: async () => { throw new Error("Slack attachments are unsupported; ask for relevant text in this conversation."); },
    };
  }
  formatReply(tag: string, text: string): string {
    const prefix = `${heading(tag)}\n`;
    let output = "";
    for (const character of text.replace(/(^|[^\p{L}\p{N}\p{M}._@-])@(?=[A-Za-z0-9_-])/gu, "$1@\u200b")) { const escaped = inertSlackText(character); if (prefix.length + output.length + escaped.length > 4_000) break; output += escaped; }
    return prefix + output;
  }
  replyBodyCharacterLimit(tag: string, max: number): number { return Math.max(0, Math.min(4_000, max) - heading(tag).length - 1); }
  async qualify() { const result = await this.provider.qualify(); if (result.status === "needs_link") throw new ChannelNeedsLinkError("slack-needs-link"); return { degraded: result.degraded, version: result.version }; }
  async watch(input: Parameters<Channel["watch"]>[0]): Promise<ChannelWatch> {
    return this.provider.subscribe({
      onObservation: async (event) => {
        const activation = slackActivation(event, input.tags());
        if (!activation) return;
        this.#remember(event.scope);
        await input.onActivation(activation);
        this.diagnostics?.({ origin: event.origin, latencyMs: Math.max(0, Date.now() - Number(event.message.ts) * 1_000) });
      },
      onHealth: (health) => { input.onHealth?.(health.state === "reconnecting" ? { state: health.state, reason: health.reason ?? "slack-reconnecting" } : { state: health.state }); },
      onRecovery: (recovery) => { this.diagnostics?.({ origin: "recovery", recovery }); input.onRecovery?.(recovery.status === "recovered" ? { status: "recovered" } : { status: "degraded", reason: recovery.reason ?? "slack-recovery-incomplete" }); },
    });
  }
  async recentMessages(chat: ChatAddress, limit: number, conversation?: unknown): Promise<CurrentChatMessage[]> {
    const authority = scope(conversation ?? this.#scopes.get(chat.id), chat); this.#remember(authority);
    const messages = await this.provider.history(authority, Math.min(50, Math.max(1, limit)));
    return messages.map((message) => ({ attachments: [], fromMe: message.fromMe === true, kind: "message", messageGuid: message.ts, occurredAt: new Date(Number(message.ts) * 1_000).toISOString(), reaction: null, sender: "Conversation participant", service: "Slack", text: message.text, urlPreview: false }));
  }
  async sendText(chat: ChatAddress, text: string, conversation?: unknown): Promise<SendDisposition> { return this.provider.reply(scope(conversation, chat), text); }
  async canCommit(chat: ChatAddress, conversation: unknown): Promise<boolean> { return this.provider.authorized(scope(conversation, chat)); }
  async reload() { await this.provider.refresh(); }
  async close() { await this.provider.close(); }
  #remember(authority: SlackScope) { if (this.#scopes.size >= 128 && !this.#scopes.has(authority.id)) this.#scopes.delete(this.#scopes.keys().next().value!); this.#scopes.set(authority.id, authority); }
}
