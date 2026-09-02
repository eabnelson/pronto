import { expect, test } from "bun:test";
import { ImsgCurrentChatSource } from "../../packages/cli/src/imessage/current-chat-source";
import type { ImsgRpc } from "../../packages/cli/src/imessage/rpc-client";

class FakeRpc implements ImsgRpc {
  async call(method: string): Promise<unknown> {
    if (method === "chats.list") {
      return { chats: [{ chat_id: 41, name: "other" }, { chat_id: 42, name: "current" }] };
    }
    return {
      messages: [
        {
          attachments: [
            { attachment_id: "ATT-1", path: "/tmp/photo.png", transfer_name: "photo.png" },
          ],
          guid: "MSG-1",
          reactions: [{ type: "heart" }],
        },
      ],
    };
  }
}

test("queries details, rich history, and attachments only through the fixed chat", async () => {
  const source = new ImsgCurrentChatSource(new FakeRpc());
  expect(await source.details(42)).toEqual({ chat_id: 42, name: "current" });
  expect(await source.history(42, 30)).toMatchObject({
    messages: [{ reactions: [{ type: "heart" }] }],
  });
  expect(await source.attachment(42, "MSG-1", "ATT-1")).toEqual({
    attachmentId: "ATT-1",
    messageGuid: "MSG-1",
    name: "photo.png",
    path: "/tmp/photo.png",
  });
  expect(await source.attachment(42, "MSG-1", "ATT-OTHER")).toBeNull();
});
