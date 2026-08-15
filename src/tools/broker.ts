import { lstat, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export interface CurrentChatSource {
  details(chatId: number): Promise<unknown>;
  history(chatId: number, limit: number): Promise<unknown>;
  attachment(
    chatId: number,
    messageGuid: string,
    attachmentId: string,
  ): Promise<{ attachmentId: string; messageGuid: string; name: string; path: string } | null>;
}

interface CapabilityState {
  chatId: number;
  expiresAt: number;
  outputCharacters: number;
}

export type CurrentChatTool =
  | "current_chat_details"
  | "current_chat_history"
  | "current_chat_attachment";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`Unknown argument: ${key}`);
  }
}

function boundedValue(value: unknown, maxCharacters: number): {
  characters: number;
  value: unknown;
} {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxCharacters) {
    return { characters: serialized.length, value };
  }
  const minimum = JSON.stringify({ preview: "", truncated: true });
  if (minimum.length > maxCharacters) throw new Error("Current-chat output budget exhausted");
  let low = 0;
  let high = serialized.length;
  let candidate: unknown = { preview: "", truncated: true };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const next = { preview: serialized.slice(0, middle), truncated: true };
    if (JSON.stringify(next).length <= maxCharacters) {
      candidate = next;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { characters: JSON.stringify(candidate).length, value: candidate };
}

export class ConversationBroker {
  readonly #capabilities = new Map<string, CapabilityState>();
  readonly #maxCallCharacters: number;
  readonly #maxTurnCharacters: number;
  readonly #now: () => number;
  readonly #source: CurrentChatSource;
  readonly #ttlMs: number;

  constructor(
    source: CurrentChatSource,
    options: {
      maxCallCharacters?: number;
      maxTurnCharacters?: number;
      now?: () => number;
      ttlMs?: number;
    } = {},
  ) {
    this.#source = source;
    this.#maxCallCharacters = options.maxCallCharacters ?? 12_000;
    this.#maxTurnCharacters = options.maxTurnCharacters ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 20 * 60 * 1_000;
  }

  issue(chatId: number): { token: string } {
    if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error("Invalid chat ID");
    const token = randomBytes(32).toString("base64url");
    this.#capabilities.set(token, {
      chatId,
      expiresAt: this.#now() + this.#ttlMs,
      outputCharacters: 0,
    });
    return { token };
  }

  revoke(token: string): void {
    this.#capabilities.delete(token);
  }

  async query(token: string, tool: string, rawArgs: unknown): Promise<unknown> {
    const capability = this.#capabilities.get(token);
    if (capability === undefined || capability.expiresAt <= this.#now()) {
      this.#capabilities.delete(token);
      throw new Error("Invalid or expired current-chat capability");
    }
    const remaining = this.#maxTurnCharacters - capability.outputCharacters;
    if (remaining < 64) throw new Error("Current-chat output budget exhausted");
    const args = object(rawArgs);
    let result: unknown;

    switch (tool as CurrentChatTool) {
      case "current_chat_details":
        exactKeys(args, []);
        result = await this.#source.details(capability.chatId);
        break;
      case "current_chat_history": {
        exactKeys(args, ["limit"]);
        const limit = args.limit ?? 30;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
          throw new Error("History limit must be an integer from 1 to 50");
        }
        result = await this.#source.history(capability.chatId, limit);
        break;
      }
      case "current_chat_attachment": {
        exactKeys(args, ["attachment_id", "message_guid"]);
        if (
          typeof args.attachment_id !== "string" ||
          args.attachment_id.length === 0 ||
          args.attachment_id.length > 256 ||
          typeof args.message_guid !== "string" ||
          args.message_guid.length === 0 ||
          args.message_guid.length > 256
        ) {
          throw new Error("Attachment and message identifiers are required");
        }
        const attachment = await this.#source.attachment(
          capability.chatId,
          args.message_guid,
          args.attachment_id,
        );
        if (attachment === null) throw new Error("Attachment is unavailable in the current chat");
        const canonicalPath = await realpath(attachment.path);
        if (!(await lstat(canonicalPath)).isFile()) throw new Error("Attachment is not a regular file");
        result = { ...attachment, path: canonicalPath };
        break;
      }
      default:
        throw new Error("Unknown current-chat tool");
    }

    const bounded = boundedValue(result, Math.min(this.#maxCallCharacters, remaining));
    capability.outputCharacters += bounded.characters;
    return bounded.value;
  }

  listen(): { close: () => void; url: string } {
    const server = Bun.serve({
      fetch: async (request) => {
        if (request.method !== "POST" || new URL(request.url).pathname !== "/query") {
          return new Response("not found", { status: 404 });
        }
        const authorization = request.headers.get("authorization");
        if (!authorization?.startsWith("Bearer ")) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const bodyText = await request.text();
        if (bodyText.length > 8_192) return Response.json({ error: "request too large" }, { status: 413 });
        try {
          const body = object(JSON.parse(bodyText));
          if (typeof body.tool !== "string") throw new Error("Tool name is required");
          const result = await this.query(
            authorization.slice("Bearer ".length),
            body.tool,
            body.arguments ?? {},
          );
          return Response.json({ result });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "query failed" },
            { status: 400 },
          );
        }
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    return {
      close: () => server.stop(true),
      url: `http://127.0.0.1:${server.port}`,
    };
  }
}
