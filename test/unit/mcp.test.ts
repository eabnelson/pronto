import { expect, test } from "bun:test";
import { handleMcpRequest, TOOL_DEFINITIONS } from "../../src/tools/mcp";

test("advertises only deterministic read-only current-chat tools", async () => {
  expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
    "current_chat_details",
    "current_chat_history",
    "current_chat_attachment",
  ]);
  expect(JSON.stringify(TOOL_DEFINITIONS)).not.toMatch(/send|react|vote|edit|unsend/i);

  const response = await handleMcpRequest(
    { id: 1, jsonrpc: "2.0", method: "tools/list", params: {} },
    async () => ({ ok: true }),
  );
  expect(response).toMatchObject({ id: 1, result: { tools: TOOL_DEFINITIONS } });
});

test("returns bounded broker data as MCP text content", async () => {
  const calls: unknown[] = [];
  const response = await handleMcpRequest(
    {
      id: "call-1",
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { limit: 10 }, name: "current_chat_history" },
    },
    async (name, args) => {
      calls.push({ args, name });
      return { messages: [] };
    },
  );

  expect(calls).toEqual([{ args: { limit: 10 }, name: "current_chat_history" }]);
  expect(response).toMatchObject({
    id: "call-1",
    result: { content: [{ text: '{"messages":[]}', type: "text" }] },
  });
});

test("supports legacy initialization without expanding capabilities", async () => {
  expect(
    await handleMcpRequest(
      { id: 1, jsonrpc: "2.0", method: "initialize", params: {} },
      async () => ({}),
    ),
  ).toMatchObject({
    result: {
      capabilities: { tools: {} },
      serverInfo: { name: "pronto-current-chat" },
    },
  });
});
