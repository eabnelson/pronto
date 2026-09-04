import type {
  ConversationFacts,
  MessagesAttachment,
  MessagesEvent,
  MessagesQualification,
} from "../types.js";

const REQUIRED_METHODS = [
  "initialize",
  "status",
  "chats.list",
  "messages.history",
  "messages.after",
  "messages.stats",
  "watch.subscribe",
  "watch.unsubscribe",
  "send",
] as const;

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function qualify(
  value: unknown,
): Omit<MessagesQualification, "databaseGeneration"> {
  const status = record(value);
  const database = record(status.database);
  if (status.protocol_version !== 1) throw new Error("Unsupported imsg RPC protocol");
  if (typeof status.version !== "string" || status.version === "") {
    throw new Error("imsg did not report a provider version");
  }
  if (database.ready !== true) throw new Error("Messages database is not readable");
  if (!Array.isArray(status.methods) || !status.methods.every((method) => typeof method === "string")) {
    throw new Error("imsg did not report usable methods");
  }
  for (const method of REQUIRED_METHODS) {
    if (!status.methods.includes(method)) throw new Error(`imsg method is unavailable: ${method}`);
  }
  const features = record(database.features);
  if (features.routing_metadata !== true) throw new Error("imsg routing metadata is unavailable");
  const degradedCapabilities: string[] = [];
  if (features.reactions !== true) degradedCapabilities.push("reactions");
  if (features.balloon_payloads !== true) degradedCapabilities.push("polls");
  if (features.reply_context !== true) degradedCapabilities.push("reply-context");
  return {
    degradedCapabilities,
    providerVersion: status.version,
    status: "ready",
  };
}

export function databasePath(value: unknown): string {
  const path = record(record(value).database).path;
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("Messages database path is unavailable");
  }
  return path;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function groupShape(value: string): boolean | null {
  const marker = /^[^;]+;([+-]);/u.exec(value)?.[1];
  return marker === "+" ? true : marker === "-" ? false : null;
}

function attachment(value: unknown): MessagesAttachment | null {
  const raw = record(value);
  if (Object.keys(raw).length === 0) return null;
  const size = raw.total_bytes ?? raw.size;
  return {
    available: false,
    mimeType: optionalString(raw.mime_type ?? raw.mimeType),
    name: optionalString(raw.name ?? raw.transfer_name ?? raw.filename),
    providerAttachmentId: optionalString(raw.attachment_id ?? raw.guid),
    sizeBytes:
      typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null,
  };
}

export function normalizeConversationFacts(
  value: unknown,
  chatId: number,
  messageValue: unknown,
  chatValue: unknown,
): ConversationFacts {
  const result = record(value);
  const statsChat = (Array.isArray(result.chats) ? result.chats : [])
    .map(record)
    .find((candidate) => candidate.chat_id === chatId);
  const message = record(messageValue);
  const chat = record(chatValue);
  const accountId = optionalString(chat.account_id);
  const accountLogin = optionalString(chat.account_login);
  const conversationId = optionalString(chat.guid);
  const destinationHandle = optionalString(chat.last_addressed_handle);
  const shapedAsGroup = conversationId === null ? null : groupShape(conversationId);
  const participants = Array.isArray(message.participants) &&
      message.participants.every((value) => typeof value === "string" && value !== "")
    ? [...new Set(message.participants)] as string[]
    : null;
  const service = statsChat !== undefined
    ? optionalString(statsChat.service)
    : optionalString(chat.service);
  const base: ConversationFacts = {
    ownerParticipated:
      typeof result.sent_messages === "number" && result.sent_messages > 0,
    service,
  };
  if (
    accountId === null || accountLogin === null || conversationId === null ||
    destinationHandle === null || chat.id !== chatId ||
    message.chat_id !== chatId || message.chat_guid !== conversationId ||
    typeof message.is_group !== "boolean" || chat.is_group !== message.is_group ||
    shapedAsGroup === null || shapedAsGroup !== message.is_group ||
    participants === null || (message.is_group && participants.length === 0)
  ) return base;
  return {
    ...base,
    routing: {
      accountId,
      accountLogin,
      conversationId,
      destinationHandle,
      isGroup: message.is_group,
      label: optionalString(message.chat_name),
      participants,
    },
  };
}

export function normalizeEvent(
  value: unknown,
  conversationFacts: ConversationFacts,
): MessagesEvent | null {
  const raw = record(value);
  const chatId = raw.chat_id;
  const rowId = raw.id;
  const providerMessageId = raw.guid;
  const reaction = record(raw.reaction);
  const poll = record(raw.poll);
  if (
    typeof chatId !== "number" || !Number.isSafeInteger(chatId) || chatId <= 0 ||
    typeof rowId !== "number" || !Number.isSafeInteger(rowId) || rowId <= 0 ||
    typeof providerMessageId !== "string" || providerMessageId === ""
  ) {
    return null;
  }
  return {
    conversation: {
      chatId,
      expiresAt: new Date(0).toISOString(),
      provider: "apple-messages",
      token: "",
      version: 1,
    },
    conversationFacts,
    message: {
      attachments: Array.isArray(raw.attachments)
        ? raw.attachments.flatMap((value) => {
          const normalized = attachment(value);
          return normalized === null ? [] : [normalized];
        })
        : [],
      destinationCallerId: optionalString(raw.destination_caller_id),
      fromMe: raw.is_from_me === true,
      kind: Object.keys(reaction).length > 0 || raw.is_reaction === true
        ? "reaction"
        : Object.keys(poll).length > 0 ? "poll" : "message",
      occurredAt: typeof raw.date === "string"
        ? raw.date
        : typeof raw.created_at === "string" ? raw.created_at : null,
      providerMessageId,
      reaction: (() => {
        const type = reaction.type ?? raw.reaction_type;
        const target = reaction.target_guid ?? reaction.targetGuid ?? raw.reacted_to_guid;
        if (typeof type !== "string" || type === "" || typeof target !== "string" || target === "") {
          return null;
        }
        const added = reaction.added ?? raw.is_reaction_add;
        return {
          added: typeof added === "boolean" ? added : null,
          targetProviderMessageId: target,
          type,
        };
      })(),
      rowId,
      replyToProviderMessageId:
        typeof raw.reply_to_guid === "string" && raw.reply_to_guid !== ""
          ? raw.reply_to_guid
          : null,
      replyToText: typeof raw.reply_to_text === "string" ? raw.reply_to_text : null,
      sender: typeof raw.sender === "string" ? raw.sender : null,
      selfChatMirror: false,
      service: typeof raw.service === "string" ? raw.service : null,
      text: typeof raw.text === "string" ? raw.text : null,
      urlPreview: raw.url_preview !== undefined,
    },
    provider: "apple-messages",
    version: 1,
  };
}
