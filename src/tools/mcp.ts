export const TOOL_DEFINITIONS = [
  {
    description: "Read supported metadata for the current iMessage chat.",
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: "current_chat_details",
  },
  {
    description: "Read a bounded page of recent messages from the current iMessage chat.",
    inputSchema: {
      additionalProperties: false,
      properties: { limit: { maximum: 50, minimum: 1, type: "integer" } },
      type: "object",
    },
    name: "current_chat_history",
  },
  {
    description: "Resolve metadata and a canonical local path for an attachment already returned from the current chat.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        attachment_id: { maxLength: 256, minLength: 1, type: "string" },
        message_guid: { maxLength: 256, minLength: 1, type: "string" },
      },
      required: ["attachment_id", "message_guid"],
      type: "object",
    },
    name: "current_chat_attachment",
  },
] as const;

export type McpQuery = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function error(id: unknown, code: number, message: string): Record<string, unknown> {
  return { error: { code, message }, id: id ?? null, jsonrpc: "2.0" };
}

export async function handleMcpRequest(
  request: unknown,
  query: McpQuery,
): Promise<Record<string, unknown> | null> {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return error(null, -32600, "Invalid request");
  }
  const message = request as Record<string, unknown>;
  const id = message.id;
  if (typeof message.method !== "string") return error(id, -32600, "Invalid request");
  if (!("id" in message)) return null;

  if (message.method === "initialize") {
    const params =
      message.params !== null && typeof message.params === "object"
        ? (message.params as Record<string, unknown>)
        : {};
    return {
      id,
      jsonrpc: "2.0",
      result: {
        capabilities: { tools: {} },
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
        serverInfo: { name: "pronto-current-chat", version: "0.1.0" },
      },
    };
  }
  if (message.method === "ping") return { id, jsonrpc: "2.0", result: {} };
  if (message.method === "tools/list") {
    return { id, jsonrpc: "2.0", result: { tools: TOOL_DEFINITIONS } };
  }
  if (message.method === "tools/call") {
    const params =
      message.params !== null && typeof message.params === "object"
        ? (message.params as Record<string, unknown>)
        : {};
    if (typeof params.name !== "string") return error(id, -32602, "Tool name is required");
    const args =
      params.arguments !== null && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    try {
      const result = await query(params.name, args);
      return {
        id,
        jsonrpc: "2.0",
        result: { content: [{ text: JSON.stringify(result), type: "text" }] },
      };
    } catch (queryError) {
      return {
        id,
        jsonrpc: "2.0",
        result: {
          content: [
            {
              text: queryError instanceof Error ? queryError.message : "Current-chat query failed",
              type: "text",
            },
          ],
          isError: true,
        },
      };
    }
  }
  return error(id, -32601, "Method not found");
}

export async function brokerQuery(
  brokerUrl: string,
  capability: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${brokerUrl}/query`, {
    body: JSON.stringify({ arguments: args, tool: name }),
    headers: {
      authorization: `Bearer ${capability}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const body = (await response.json()) as { error?: string; result?: unknown };
  if (!response.ok) throw new Error(body.error ?? "Current-chat broker rejected the request");
  return body.result;
}

export async function runMcpStdio(query: McpQuery): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify(error(null, -32700, "Parse error"))}\n`);
        continue;
      }
      const response = await handleMcpRequest(request, query);
      if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}
