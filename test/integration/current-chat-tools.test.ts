import { expect, test } from "bun:test";
import { ConversationBroker, type CurrentChatSource } from "../../packages/cli/src/tools/broker";
import { brokerQuery } from "../../packages/cli/src/tools/mcp";

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

test("rejects request bodies over the byte limit before parsing tool arguments", async () => {
  const broker = new ConversationBroker(new TwoChatSource());
  const capability = broker.issue(1);
  const listener = broker.listen();
  try {
    const response = await fetch(`${listener.url}/query`, {
      body: JSON.stringify({
        arguments: { padding: "😀".repeat(3_000) },
        tool: "current_chat_details",
      }),
      headers: {
        authorization: `Bearer ${capability.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(response.status).toBe(413);
  } finally {
    listener.close();
  }
});
