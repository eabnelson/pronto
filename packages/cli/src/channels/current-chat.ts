import type { CurrentChatSource } from "../tools/broker";
import type { Channel, ChannelKind, ChatAddress } from "./types";

/** Sends each current-chat tool call to the channel that owns the chat. */
export function routeCurrentChat(channels: ReadonlyMap<ChannelKind, Channel>): CurrentChatSource {
  const owner = (chat: ChatAddress): CurrentChatSource => {
    const channel = channels.get(chat.channel);
    if (channel === undefined) throw new Error("Current conversation scope is unavailable");
    return channel.currentChat;
  };
  return {
    attachment: (chat, messageGuid, attachmentId) =>
      owner(chat).attachment(chat, messageGuid, attachmentId),
    details: (chat) => owner(chat).details(chat),
    history: (chat, limit) => owner(chat).history(chat, limit),
  };
}
