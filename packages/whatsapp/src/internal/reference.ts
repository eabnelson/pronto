import { createHmac, timingSafeEqual } from "node:crypto";
import { WHATSAPP_PROVIDER, type WhatsappConversationReference } from "../types.js";

export const SCOPE_UNAVAILABLE = "Current conversation scope is unavailable";

const CHAT_JID = /^[0-9A-Za-z][0-9A-Za-z._-]*@(s\.whatsapp\.net|g\.us|lid)$/;

export function isAddressableChatJid(value: string): boolean {
  return value.length <= 256 && CHAT_JID.test(value);
}

export class ReferenceSigner {
  constructor(
    private readonly key: string,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  issue(chatJid: string): WhatsappConversationReference {
    const expiresAt = new Date(this.now() + this.ttlMs).toISOString();
    return {
      chatJid,
      expiresAt,
      provider: WHATSAPP_PROVIDER,
      token: this.#sign(chatJid, expiresAt),
      version: 1,
    };
  }

  /** Returns the chat JID the reference proves, or throws. */
  verify(reference: unknown): string {
    if (typeof reference !== "object" || reference === null) throw new Error(SCOPE_UNAVAILABLE);
    const candidate = reference as Partial<Record<keyof WhatsappConversationReference, unknown>>;
    const { chatJid, expiresAt, provider, token, version } = candidate;
    if (
      provider !== WHATSAPP_PROVIDER
      || version !== 1
      || typeof chatJid !== "string"
      || typeof expiresAt !== "string"
      || typeof token !== "string"
      || !isAddressableChatJid(chatJid)
    ) {
      throw new Error(SCOPE_UNAVAILABLE);
    }
    const expected = Buffer.from(this.#sign(chatJid, expiresAt));
    const actual = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error(SCOPE_UNAVAILABLE);
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      throw new Error(SCOPE_UNAVAILABLE);
    }
    return chatJid;
  }

  #sign(chatJid: string, expiresAt: string): string {
    return createHmac("sha256", this.key)
      .update(`${WHATSAPP_PROVIDER}\0${1}\0${chatJid}\0${expiresAt}`)
      .digest("base64url");
  }
}
