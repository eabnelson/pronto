import { basename } from "node:path";
import type { CurrentChatSource } from "../tools/broker";
import type { ImsgRpc } from "./rpc-client";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  const container = record(value);
  return container !== null && Array.isArray(container[key]) ? container[key] : [];
}

function numericId(value: Record<string, unknown>): number | null {
  for (const key of ["chat_id", "id", "rowid"]) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}

function stringField(value: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

export class ImsgCurrentChatSource implements CurrentChatSource {
  constructor(readonly rpc: ImsgRpc) {}

  async details(chatId: number): Promise<unknown> {
    const result = await this.rpc.call("chats.list", { limit: 100 });
    const chat = list(result, "chats")
      .map(record)
      .find((candidate) => candidate !== null && numericId(candidate) === chatId);
    if (chat === undefined || chat === null) throw new Error("Current chat details are unavailable");
    return chat;
  }

  async history(chatId: number, limit: number): Promise<unknown> {
    return this.rpc.call("messages.history", {
      attachments: true,
      chat_id: chatId,
      include_reactions: true,
      limit,
    });
  }

  async attachment(chatId: number, messageGuid: string, attachmentId: string) {
    const result = await this.history(chatId, 50);
    for (const candidate of list(result, "messages")) {
      const message = record(candidate);
      if (message === null || stringField(message, ["guid", "message_guid"]) !== messageGuid) {
        continue;
      }
      for (const rawAttachment of list(message.attachments, "attachments")) {
        const attachment = record(rawAttachment);
        if (attachment === null) continue;
        const id = stringField(attachment, ["attachment_id", "guid", "id"]);
        if (id !== attachmentId) continue;
        const path = stringField(attachment, ["path", "original_path", "filename"]);
        if (path === null) return null;
        return {
          attachmentId: id,
          messageGuid,
          name:
            stringField(attachment, ["name", "transfer_name", "filename"]) ?? basename(path),
          path,
        };
      }
    }
    return null;
  }
}
