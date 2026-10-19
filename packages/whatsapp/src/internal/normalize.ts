import { createHash } from "node:crypto";
import type { WhatsappMedia, WhatsappMessageKind } from "../types.js";
import { isRecord } from "./process.js";
import { isAddressableChatJid } from "./reference.js";

/** A provider message reduced to the fields the module delivers, before scoping. */
export interface RawMessage {
  readonly chatJid: string;
  readonly fromMe: boolean;
  readonly id: string;
  readonly kind: WhatsappMessageKind;
  readonly media: WhatsappMedia | null;
  readonly occurredAtMs: number;
  readonly replyToId: string | null;
  readonly senderJid: string | null;
  readonly senderName: string | null;
  readonly text: string | null;
}

export function isExcludedChat(chatJid: string): boolean {
  return chatJid.endsWith("@broadcast") || chatJid.endsWith("@newsletter");
}

/** Drops the device suffix: `123:4@s.whatsapp.net` becomes `123@s.whatsapp.net`. */
export function canonicalJid(value: string): string {
  const at = value.indexOf("@");
  if (at < 0) return value;
  const user = value.slice(0, at).split(":")[0] ?? "";
  return `${user}${value.slice(at)}`;
}

export function jidUser(value: string): string {
  const at = value.indexOf("@");
  return (at < 0 ? value : value.slice(0, at)).split(":")[0] ?? "";
}

/**
 * Dedupe key. It uses the message ID alone: wacli can file the same message under a chat's
 * phone-number JID and later its LID (or the reverse), and the message must still be seen once.
 * Edits and revokes reuse the target message ID, so they get their own keys.
 */
export function deliveryKey(message: Pick<RawMessage, "id" | "kind" | "text">): string {
  const base = `id|${message.id}`;
  if (message.kind === "edit") {
    const digest = createHash("sha256").update(message.text ?? "").digest("base64url").slice(0, 16);
    return `${base}|edit|${digest}`;
  }
  if (message.kind === "revoke") return `${base}|revoke`;
  return base;
}

/** Normalizes a `sync --webhook` message payload. Returns null for payloads the module never delivers. */
export function fromWebhook(payload: unknown): RawMessage | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.EventType === "string" && payload.EventType !== "message") return null;
  const chatJid = canonicalJid(string(payload.Chat) ?? "");
  const id = string(payload.ID);
  const occurredAtMs = timestamp(payload.Timestamp);
  if (!isAddressableChatJid(chatJid) || isExcludedChat(chatJid) || id === null || occurredAtMs === null) {
    return null;
  }
  const rawMedia = isRecord(payload.Media) ? payload.Media : null;
  const media: WhatsappMedia | null = rawMedia === null || string(rawMedia.Type) === null
    ? null
    : {
      caption: string(rawMedia.Caption),
      filename: string(rawMedia.Filename),
      mimeType: string(rawMedia.MimeType),
      sizeBytes: typeof rawMedia.FileLength === "number" && Number.isSafeInteger(rawMedia.FileLength)
        ? rawMedia.FileLength
        : null,
      type: string(rawMedia.Type) ?? "",
    };
  const text = string(payload.Text) ?? media?.caption ?? null;
  let kind: WhatsappMessageKind;
  if (string(payload.ReactionToID) !== null || string(payload.ReactionEmoji) !== null) kind = "reaction";
  else if (payload.Revoked === true) kind = "revoke";
  else if (payload.Edited === true) kind = "edit";
  else if (present(payload.Poll) || present(payload.PollVote) || present(payload.PollAdd)) kind = "poll";
  else if (present(payload.Call)) kind = "call";
  else if (string(payload.UnhandledPayload) !== null || (text === null && media === null)) kind = "unsupported";
  else kind = "message";
  const sender = string(payload.SenderJID);
  return {
    chatJid,
    fromMe: payload.FromMe === true,
    id,
    kind,
    media,
    occurredAtMs,
    replyToId: string(payload.ReplyToID),
    senderJid: sender === null ? null : canonicalJid(sender),
    senderName: string(payload.PushName),
    text,
  };
}

/**
 * Normalizes a `messages list --json` row. Stored rows already fold edits into the original
 * message, so an edited row is delivered as the message it now is.
 */
export function fromStoredRow(row: unknown): RawMessage | null {
  if (!isRecord(row)) return null;
  const chatJid = canonicalJid(string(row.ChatJID) ?? "");
  const id = string(row.MsgID);
  const occurredAtMs = timestamp(row.Timestamp);
  if (!isAddressableChatJid(chatJid) || isExcludedChat(chatJid) || id === null || occurredAtMs === null) {
    return null;
  }
  if (row.DeletedForMe === true) return null;
  const mediaType = string(row.MediaType);
  const media: WhatsappMedia | null = mediaType === null
    ? null
    : {
      caption: string(row.MediaCaption),
      filename: string(row.Filename),
      mimeType: string(row.MimeType),
      sizeBytes: null,
      type: mediaType,
    };
  const text = string(row.Text) ?? media?.caption ?? null;
  let kind: WhatsappMessageKind;
  if (string(row.ReactionToID) !== null || string(row.ReactionEmoji) !== null) kind = "reaction";
  else if (row.Revoked === true) kind = "revoke";
  else if (text === null && media === null) kind = "unsupported";
  else kind = "message";
  const sender = string(row.SenderJID);
  return {
    chatJid,
    fromMe: row.FromMe === true,
    id,
    kind,
    media,
    occurredAtMs,
    replyToId: string(row.quoted_msg_id),
    senderJid: sender === null ? null : canonicalJid(sender),
    senderName: string(row.SenderName),
    text,
  };
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
