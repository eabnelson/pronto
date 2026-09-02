import { afterEach, expect, mock, test } from "bun:test";
import { brokerQuery, handleMcpRequest, TOOL_DEFINITIONS } from "../../packages/cli/src/tools/mcp";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

test("refuses every broker URL that is not the literal local HTTP listener", async () => {
  const fetchMock = mock(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ result: {} }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  for (const brokerUrl of [
    "https://example.com:443",
    "http://169.254.169.254:80",
    "http://127.0.0.1.evil.example:80",
    "http://127.0.0.1@evil.example:80",
    "http://[::1]:9000",
    "http://127.0.0.1:9000/unexpected",
  ]) {
    await expect(brokerQuery(brokerUrl, "capability", "current_chat_details", {}))
      .rejects.toThrow("local loopback");
  }
  expect(fetchMock).not.toHaveBeenCalled();

  await expect(brokerQuery(
    "http://127.0.0.1:9000",
    "capability",
    "current_chat_details",
    {},
  )).resolves.toEqual({});
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9000/query");
});
