import { expect, test } from "bun:test";
import { ConversationBroker, type CurrentChatSource } from "../../src/tools/broker";
import { brokerQuery } from "../../src/tools/mcp";

class TwoChatSource implements CurrentChatSource {
  async details(chatId: number): Promise<unknown> {
    return { opaqueFixtureChat: chatId === 1 ? "alpha" : "beta" };
  }

  async history(chatId: number, limit: number): Promise<unknown> {
    return { chat: chatId, limit, messages: [] };
  }

  async attachment(): Promise<null> {
    return null;
  }
}

test("isolates two simultaneous capabilities through the loopback broker", async () => {
  const broker = new ConversationBroker(new TwoChatSource());
  const first = broker.issue(1);
  const second = broker.issue(2);
  const listener = broker.listen();
  try {
    expect(listener.url).toStartWith("http://127.0.0.1:");
    const [firstResult, secondResult] = await Promise.all([
      brokerQuery(listener.url, first.token, "current_chat_details", {}),
      brokerQuery(listener.url, second.token, "current_chat_details", {}),
    ]);
    expect(firstResult).toEqual({ opaqueFixtureChat: "alpha" });
    expect(secondResult).toEqual({ opaqueFixtureChat: "beta" });

    broker.revoke(first.token);
    await expect(
      brokerQuery(listener.url, first.token, "current_chat_details", {}),
    ).rejects.toThrow("Invalid or expired");
    expect(await brokerQuery(listener.url, second.token, "current_chat_history", { limit: 5 })).toEqual({
      chat: 2,
      limit: 5,
      messages: [],
    });
  } finally {
    listener.close();
  }
});
