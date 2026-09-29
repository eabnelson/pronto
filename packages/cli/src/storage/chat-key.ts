import { createHmac } from "node:crypto";
import type { ChatAddress } from "../channels/types";

export function chatKeyForId(chatId: number, privateSalt: string): string {
  if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error("Invalid chat ID");
  return hashedChatKey(String(chatId), privateSalt);
}

// iMessage keys keep their original input so existing memory and workspaces stay attached.
export function chatKeyForAddress(chat: ChatAddress, privateSalt: string): string {
  if (chat.channel === "imessage") return chatKeyForId(imessageChatId(chat), privateSalt);
  if (chat.id.length === 0) throw new Error("Invalid chat ID");
  return hashedChatKey(`${chat.channel}:${chat.id}`, privateSalt);
}

export function imessageChatId(chat: ChatAddress): number {
  const chatId = Number(chat.id);
  if (chat.channel !== "imessage" || !/^[1-9][0-9]*$/.test(chat.id) || !Number.isSafeInteger(chatId)) {
    throw new Error("Invalid chat ID");
  }
  return chatId;
}

function hashedChatKey(input: string, privateSalt: string): string {
  if (privateSalt.length < 8) throw new Error("Invalid chat-key salt");
  return `c_${createHmac("sha256", privateSalt)
    .update(input)
    .digest("base64url")
    .slice(0, 32)}`;
}
