import { createHmac } from "node:crypto";

export function chatKeyForId(chatId: number, privateSalt: string): string {
  if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error("Invalid chat ID");
  if (privateSalt.length < 8) throw new Error("Invalid chat-key salt");
  return `c_${createHmac("sha256", privateSalt)
    .update(String(chatId))
    .digest("base64url")
    .slice(0, 32)}`;
}
