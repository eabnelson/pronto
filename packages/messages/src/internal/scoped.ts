import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { normalizeEvent, record } from "./normalize.js";
import type { ResilientRpcClient } from "./rpc.js";
import type {
  AttachmentReference,
  ConversationFacts,
  ConversationReference,
  MaterializedAttachment,
  MessagesAttachment,
  MessagesEvent,
  MessagesHistoryBudget,
  MessagesHistoryPage,
  MessagesScopeLimits,
} from "../types.js";

const DEFAULT_LIMITS = {
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxAttachmentCount: 32,
  maxHistoryBytes: 8 * 1024 * 1024,
  maxHistoryMessages: 2_000,
  maxHistoryRows: 20_000,
  maxHistoryRpcCalls: 64,
  ttlMs: 15 * 60_000,
} as const;

interface CapabilityScope {
  readonly capabilityId: string;
  readonly chatId: number;
  readonly expiresAt: number;
  readonly generation: string;
  readonly v: 1;
}

interface ConversationPayload extends CapabilityScope {
  readonly facts: ConversationFacts;
  readonly kind: "conversation";
  readonly limits: DeferredLimits;
}

interface ContinuationPayload extends CapabilityScope {
  readonly cursor: number;
  readonly includeReactions: boolean;
  readonly kind: "history";
  readonly mode: "forward" | "recent";
}

interface FileEvidence {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

interface AttachmentPayload extends CapabilityScope {
  readonly attachmentIndex: number;
  readonly evidence: FileEvidence;
  readonly kind: "attachment";
  readonly messageGuid: string;
  readonly messageRowId: number;
  readonly mimeType: string;
  readonly name: string;
  readonly path: string;
  readonly providerAttachmentId: string | null;
  readonly size: number;
}

interface CapabilityUsage {
  attachments: number;
  attachmentBytes: number;
  expiresAt: number;
  historyBytes: number;
  historyMessages: number;
  historyRows: number;
  historyRpcCalls: number;
}

interface ParsedAttachment {
  readonly mimeType: string;
  readonly missing: boolean;
  readonly name: string;
  readonly path: string;
  readonly providerAttachmentId: string | null;
  readonly size: number;
}

interface DeferredLimits {
  readonly maxAttachmentBytes: number;
  readonly maxAttachmentCount: number;
  readonly maxHistoryBytes: number;
  readonly maxHistoryMessages: number;
  readonly maxHistoryRows: number;
  readonly maxHistoryRpcCalls: number;
  readonly ttlMs: number;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function safeString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
      !/[\u0000-\u001f]/u.test(value)
    ? value
    : undefined;
}

function safeName(value: unknown): string | undefined {
  const candidate = safeString(value, 1_024);
  if (candidate === undefined) return undefined;
  const name = basename(candidate);
  return name !== "." && name !== ".." ? name : undefined;
}

function safeMime(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 128 &&
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value)
    ? value.toLowerCase()
    : undefined;
}

function scopeLimits(input: MessagesScopeLimits | undefined): DeferredLimits {
  const value = { ...DEFAULT_LIMITS, ...input };
  if (!Object.values(value).every(positiveInteger)) {
    throw new Error("messages_scope_limits_invalid");
  }
  return value;
}

function validBudget(value: MessagesHistoryBudget): boolean {
  return Object.values(value).every(positiveInteger);
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function stableRegularFile(value: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly nlink: number;
  readonly blocks: number;
  readonly size: number;
}): boolean {
  return value.isFile() && !value.isSymbolicLink() && value.nlink === 1 &&
    (value.size === 0 || value.blocks * 512 >= value.size);
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || process.getuid() === uid;
}

function parseAttachment(value: unknown): ParsedAttachment | undefined {
  const raw = record(value);
  const path = safeString(raw.original_path ?? raw.path, 32_000);
  const name = safeName(raw.transfer_name ?? raw.name ?? raw.filename);
  const mimeType = safeMime(raw.mime_type ?? raw.mimeType) ?? "application/octet-stream";
  const size = raw.total_bytes ?? raw.size;
  if (path === undefined || name === undefined || !nonNegativeInteger(size)) return undefined;
  return {
    mimeType,
    missing: raw.missing === true,
    name,
    path,
    providerAttachmentId: safeString(raw.attachment_id ?? raw.guid, 1_024) ?? null,
    size,
  };
}

function detectedMime(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6) {
    const header = data.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (data.length >= 5 && data.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return "application/zip";
  }
  try {
    if (data.length > 0 && !data.includes(0)) {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
      return "text/plain";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function mimeCompatible(advertised: string, detected: string | undefined): boolean {
  if (detected === undefined) return false;
  if (advertised === "application/octet-stream" || advertised === detected) return true;
  return detected === "text/plain" && advertised.startsWith("text/");
}

function validCapabilityScope(value: unknown): value is CapabilityScope {
  const item = record(value);
  return item.v === 1 && safeString(item.capabilityId, 256) !== undefined &&
    positiveInteger(item.chatId) && positiveInteger(item.expiresAt) &&
    safeString(item.generation, 256) !== undefined;
}

function validConversationPayload(value: unknown): value is ConversationPayload {
  if (!validCapabilityScope(value)) return false;
  const item = record(value);
  const facts = record(item.facts);
  const limits = record(item.limits);
  return item.kind === "conversation" &&
    typeof facts.ownerParticipated === "boolean" &&
    (facts.service === null || safeString(facts.service, 256) !== undefined) &&
    Object.keys(DEFAULT_LIMITS).every((key) => positiveInteger(limits[key]));
}

function validContinuationPayload(value: unknown): value is ContinuationPayload {
  if (!validCapabilityScope(value)) return false;
  const item = record(value);
  return item.kind === "history" && nonNegativeInteger(item.cursor) &&
    typeof item.includeReactions === "boolean" &&
    (item.mode === "forward" || item.mode === "recent");
}

function validFileEvidence(value: unknown): value is FileEvidence {
  const item = record(value);
  return nonNegativeInteger(item.dev) && nonNegativeInteger(item.ino) &&
    typeof item.mtimeMs === "number" && Number.isFinite(item.mtimeMs) &&
    nonNegativeInteger(item.size);
}

function validAttachmentPayload(value: unknown): value is AttachmentPayload {
  if (!validCapabilityScope(value)) return false;
  const item = record(value);
  return item.kind === "attachment" && nonNegativeInteger(item.attachmentIndex) &&
    positiveInteger(item.messageRowId) &&
    safeString(item.messageGuid, 1_024) !== undefined && safeName(item.name) !== undefined &&
    safeMime(item.mimeType) !== undefined && typeof item.path === "string" && isAbsolute(item.path) &&
    (item.providerAttachmentId === null || safeString(item.providerAttachmentId, 1_024) !== undefined) &&
    nonNegativeInteger(item.size) && validFileEvidence(item.evidence);
}

export class ScopedMessagesAccess {
  readonly #rpc: ResilientRpcClient;
  readonly #generation: () => Promise<string>;
  readonly #key: Buffer;
  readonly #limits: DeferredLimits;
  readonly #now: () => number;
  readonly #attachmentsRoot: string;
  readonly #scratchRoot: string;
  readonly #usage = new Map<string, CapabilityUsage>();

  constructor(input: {
    readonly attachmentsRoot?: string;
    readonly generation: () => Promise<string>;
    readonly limits?: MessagesScopeLimits;
    readonly now?: () => number;
    readonly rpc: ResilientRpcClient;
    readonly scratchRoot?: string;
  }) {
    this.#rpc = input.rpc;
    this.#generation = input.generation;
    this.#key = createHash("sha256").update(randomBytes(32)).digest();
    this.#limits = scopeLimits(input.limits);
    this.#now = input.now ?? Date.now;
    this.#attachmentsRoot = resolve(
      input.attachmentsRoot ?? join(homedir(), "Library", "Messages", "Attachments"),
    );
    this.#scratchRoot = resolve(
      input.scratchRoot ?? join(tmpdir(), `pronto-imessage-${process.getuid?.() ?? "owner"}`),
    );
  }

  issueConversation(
    chatId: number,
    generation: string,
    facts: ConversationFacts,
  ): ConversationReference {
    const payload: ConversationPayload = {
      capabilityId: randomBytes(24).toString("base64url"),
      chatId,
      expiresAt: this.#now() + this.#limits.ttlMs,
      facts,
      generation,
      kind: "conversation",
      limits: this.#limits,
      v: 1,
    };
    this.#usage.set(payload.capabilityId, {
      attachments: 0,
      attachmentBytes: 0,
      expiresAt: payload.expiresAt,
      historyBytes: 0,
      historyMessages: 0,
      historyRows: 0,
      historyRpcCalls: 0,
    });
    while (this.#usage.size > 1_024) {
      const oldest = this.#usage.keys().next().value;
      if (oldest === undefined) break;
      this.#usage.delete(oldest);
    }
    return {
      chatId,
      expiresAt: new Date(payload.expiresAt).toISOString(),
      provider: "apple-messages",
      token: this.#seal(payload, "conversation"),
      version: 1,
    };
  }

  async decorateEvent(
    event: MessagesEvent,
    rawMessage: Record<string, unknown>,
    generation: string,
    existingConversation?: ConversationReference,
  ): Promise<MessagesEvent> {
    const conversation = existingConversation ??
      this.issueConversation(event.conversation.chatId, generation, event.conversationFacts);
    const rawAttachments = Array.isArray(rawMessage.attachments) ? rawMessage.attachments : [];
    const attachments = await Promise.all(event.message.attachments.map(async (attachment, index) =>
      await this.#describeAttachment(
        attachment,
        rawAttachments[index],
        event,
        conversation,
        generation,
        index,
      )
    ));
    return {
      ...event,
      conversation,
      message: { ...event.message, attachments },
    };
  }

  async conversation(reference: ConversationReference): Promise<ConversationPayload> {
    const payload = this.#open(reference.token, "conversation", validConversationPayload);
    if (
      reference.version !== 1 || reference.provider !== "apple-messages" ||
      reference.chatId !== payload.chatId ||
      reference.expiresAt !== new Date(payload.expiresAt).toISOString() ||
      payload.expiresAt <= this.#now() || !this.#usage.has(payload.capabilityId)
    ) throw new Error("messages_conversation_reference_invalid");
    if (await this.#generation() !== payload.generation) {
      throw new Error("messages_conversation_scope_changed");
    }
    return payload;
  }

  async history(input: {
    readonly budget: MessagesHistoryBudget;
    readonly continuation?: string;
    readonly conversation: ConversationReference;
    readonly includeReactions?: boolean;
    readonly mode?: "forward" | "recent";
  }): Promise<MessagesHistoryPage> {
    if (!validBudget(input.budget)) throw new Error("messages_history_budget_invalid");
    const scope = await this.conversation(input.conversation);
    const usage = this.#capabilityUsage(scope);
    const continuation = input.continuation === undefined
      ? undefined
      : this.#open(input.continuation, "history", validContinuationPayload);
    const mode = continuation?.mode ?? input.mode ?? "recent";
    const includeReactions = continuation?.includeReactions ?? input.includeReactions ?? false;
    if (
      continuation !== undefined &&
      (continuation.capabilityId !== scope.capabilityId ||
        continuation.chatId !== scope.chatId || continuation.generation !== scope.generation ||
        continuation.expiresAt <= this.#now() || input.mode !== undefined ||
        input.includeReactions !== undefined)
    ) throw new Error("messages_history_continuation_invalid");
    const remaining = {
      maxBytes: Math.min(input.budget.maxBytes, scope.limits.maxHistoryBytes - usage.historyBytes),
      maxMessages: Math.min(
        input.budget.maxMessages,
        scope.limits.maxHistoryMessages - usage.historyMessages,
      ),
      maxRows: Math.min(input.budget.maxRows, scope.limits.maxHistoryRows - usage.historyRows),
      maxRpcCalls: Math.min(
        input.budget.maxRpcCalls,
        scope.limits.maxHistoryRpcCalls - usage.historyRpcCalls,
      ),
    };
    if (Object.values(remaining).some((value) => value <= 0)) {
      throw new Error("messages_history_budget_exhausted");
    }
    usage.historyBytes += remaining.maxBytes;
    usage.historyMessages += remaining.maxMessages;
    usage.historyRows += remaining.maxRows;
    usage.historyRpcCalls += 1;
    const cursor = continuation?.cursor ?? 0;
    const method = continuation === undefined && mode === "recent"
      ? "messages.history"
      : "messages.after";
    const result = record(await this.#rpc.request(method, method === "messages.history" ? {
      attachments: true,
      chat_id: scope.chatId,
      include_reactions: includeReactions,
      limit: Math.min(500, remaining.maxMessages, remaining.maxRows),
    } : {
      attachments: true,
      chat_id: scope.chatId,
      convert_attachments: false,
      include_reactions: includeReactions,
      limit: Math.min(500, remaining.maxMessages, remaining.maxRows),
      since_rowid: cursor,
    }));
    const rawMessages = result.messages;
    if (!Array.isArray(rawMessages)) throw new Error("messages_history_response_invalid");
    const bytes = Buffer.byteLength(JSON.stringify(rawMessages), "utf8");
    if (
      rawMessages.length > remaining.maxMessages || rawMessages.length > remaining.maxRows ||
      bytes > remaining.maxBytes
    ) throw new Error("messages_history_budget_exceeded");
    const events: MessagesEvent[] = [];
    for (const rawValue of rawMessages) {
      const raw = record(rawValue);
      if (raw.chat_id !== scope.chatId) throw new Error("messages_history_scope_changed");
      const normalized = normalizeEvent(raw, scope.facts);
      if (normalized === null) throw new Error("messages_history_response_invalid");
      events.push(await this.decorateEvent(
        normalized,
        raw,
        scope.generation,
        input.conversation,
      ));
    }
    events.sort((left, right) => left.message.rowId - right.message.rowId);
    const nextRowId = result.next_rowid;
    if (typeof result.has_more !== "boolean") {
      throw new Error("messages_history_response_invalid");
    }
    const hasMore = result.has_more;
    if (
      hasMore && (!nonNegativeInteger(nextRowId) || nextRowId <= cursor)
    ) throw new Error("messages_history_cursor_invalid");
    if (scope.expiresAt <= this.#now() || await this.#generation() !== scope.generation) {
      throw new Error("messages_history_scope_changed");
    }
    usage.historyBytes -= remaining.maxBytes - bytes;
    usage.historyMessages -= remaining.maxMessages - events.length;
    usage.historyRows -= remaining.maxRows - rawMessages.length;
    return {
      hasMore,
      messages: events,
      scannedBytes: bytes,
      scannedRows: rawMessages.length,
      ...(hasMore ? {
        continuation: this.#seal({
          capabilityId: scope.capabilityId,
          chatId: scope.chatId,
          cursor: Number(nextRowId),
          expiresAt: scope.expiresAt,
          generation: scope.generation,
          includeReactions,
          kind: "history",
          mode,
          v: 1,
        } satisfies ContinuationPayload, "history"),
      } : {}),
    };
  }

  async materializeAttachment(input: {
    readonly attachment: AttachmentReference;
    readonly conversation: ConversationReference;
    readonly maxBytes: number;
  }): Promise<MaterializedAttachment> {
    if (!positiveInteger(input.maxBytes)) throw new Error("messages_attachment_budget_invalid");
    const scope = await this.conversation(input.conversation);
    const payload = this.#open(input.attachment.token, "attachment", validAttachmentPayload);
    if (
      input.attachment.version !== 1 || input.attachment.provider !== "apple-messages" ||
      input.attachment.expiresAt !== new Date(payload.expiresAt).toISOString() ||
      payload.expiresAt <= this.#now() || payload.capabilityId !== scope.capabilityId ||
      payload.chatId !== scope.chatId || payload.generation !== scope.generation
    ) throw new Error("messages_attachment_reference_invalid");
    const usage = this.#capabilityUsage(scope);
    if (
      payload.size > input.maxBytes || payload.size > scope.limits.maxAttachmentBytes ||
      usage.attachments >= scope.limits.maxAttachmentCount ||
      usage.attachmentBytes + payload.size > scope.limits.maxAttachmentBytes
    ) throw new Error("messages_attachment_budget_exhausted");
    usage.attachments += 1;
    usage.attachmentBytes += payload.size;
    await this.#revalidateAttachment(payload);
    const materialized = await this.#copyAttachment(payload);
    if (payload.expiresAt <= this.#now() || await this.#generation() !== payload.generation) {
      await materialized.dispose().catch(() => undefined);
      throw new Error("messages_attachment_scope_changed");
    }
    return materialized;
  }

  async #describeAttachment(
    fallback: MessagesAttachment,
    rawValue: unknown,
    event: MessagesEvent,
    conversation: ConversationReference,
    generation: string,
    attachmentIndex: number,
  ): Promise<MessagesAttachment> {
    const parsed = parseAttachment(rawValue);
    if (parsed === undefined || parsed.missing || parsed.size > this.#limits.maxAttachmentBytes) {
      return { ...fallback, available: false };
    }
    const evidence = await this.#fileEvidence(parsed.path).catch(() => undefined);
    if (evidence === undefined || evidence.size !== parsed.size) {
      return { ...fallback, available: false };
    }
    const scope = this.#open(conversation.token, "conversation", validConversationPayload);
    const payload: AttachmentPayload = {
      attachmentIndex,
      capabilityId: scope.capabilityId,
      chatId: scope.chatId,
      evidence,
      expiresAt: scope.expiresAt,
      generation,
      kind: "attachment",
      messageGuid: event.message.providerMessageId,
      messageRowId: event.message.rowId,
      mimeType: parsed.mimeType,
      name: parsed.name,
      path: resolve(parsed.path),
      providerAttachmentId: parsed.providerAttachmentId,
      size: parsed.size,
      v: 1,
    };
    return {
      available: true,
      mimeType: parsed.mimeType,
      name: parsed.name,
      providerAttachmentId: parsed.providerAttachmentId,
      reference: {
        expiresAt: new Date(payload.expiresAt).toISOString(),
        provider: "apple-messages",
        token: this.#seal(payload, "attachment"),
        version: 1,
      },
      sizeBytes: parsed.size,
    };
  }

  async #revalidateAttachment(payload: AttachmentPayload): Promise<void> {
    if (await this.#generation() !== payload.generation) {
      throw new Error("messages_attachment_scope_changed");
    }
    const result = record(await this.#rpc.request("messages.after", {
      attachments: true,
      chat_id: payload.chatId,
      convert_attachments: false,
      include_reactions: false,
      limit: 1,
      since_rowid: payload.messageRowId - 1,
    }));
    const messages = result.messages;
    if (!Array.isArray(messages) || messages.length !== 1) {
      throw new Error("messages_attachment_message_changed");
    }
    const message = record(messages[0]);
    const attachments = message.attachments;
    if (
      message.id !== payload.messageRowId || message.guid !== payload.messageGuid ||
      message.chat_id !== payload.chatId || !Array.isArray(attachments)
    ) throw new Error("messages_attachment_message_changed");
    const current = parseAttachment(attachments[payload.attachmentIndex]);
    if (
      current === undefined || current.missing || current.path !== payload.path ||
      current.name !== payload.name || current.mimeType !== payload.mimeType ||
      current.providerAttachmentId !== payload.providerAttachmentId || current.size !== payload.size
    ) throw new Error("messages_attachment_metadata_changed");
  }

  async #fileEvidence(path: string): Promise<FileEvidence> {
    const lexical = resolve(path);
    const rootMetadata = await lstat(this.#attachmentsRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() ||
      !ownedByCurrentUser(rootMetadata.uid)) throw new Error("messages_attachment_unsafe");
    const [rootReal, pathReal, metadata] = await Promise.all([
      realpath(this.#attachmentsRoot),
      realpath(lexical),
      lstat(lexical),
    ]);
    if (!inside(rootReal, pathReal) || !stableRegularFile(metadata)) {
      throw new Error("messages_attachment_unsafe");
    }
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
    };
  }

  async #copyAttachment(payload: AttachmentPayload): Promise<MaterializedAttachment> {
    const before = await this.#fileEvidence(payload.path);
    if (
      before.dev !== payload.evidence.dev || before.ino !== payload.evidence.ino ||
      before.mtimeMs !== payload.evidence.mtimeMs || before.size !== payload.evidence.size
    ) throw new Error("messages_attachment_file_changed");
    const scratchRoot = await this.#qualifiedScratchRoot();
    const directory = await mkdtemp(join(scratchRoot, "attachment-"));
    const targetPath = join(directory, payload.name);
    let source;
    let target;
    try {
      source = await open(payload.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await source.stat();
      if (
        !stableRegularFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.mtimeMs !== before.mtimeMs || opened.size !== before.size
      ) throw new Error("messages_attachment_file_changed");
      target = await open(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, payload.size)));
      const digest = createHash("sha256");
      const sniff: Buffer[] = [];
      let sniffBytes = 0;
      let offset = 0;
      while (offset < payload.size) {
        const read = await source.read(chunk, 0, Math.min(chunk.length, payload.size - offset), offset);
        if (read.bytesRead <= 0) throw new Error("messages_attachment_size_changed");
        const bytes = chunk.subarray(0, read.bytesRead);
        await target.write(bytes, 0, bytes.length, offset);
        digest.update(bytes);
        if (sniffBytes < 64 * 1024) {
          const part = Buffer.from(bytes.subarray(0, 64 * 1024 - sniffBytes));
          sniff.push(part);
          sniffBytes += part.length;
        }
        offset += read.bytesRead;
      }
      if ((await source.read(Buffer.allocUnsafe(1), 0, 1, payload.size)).bytesRead !== 0) {
        throw new Error("messages_attachment_size_changed");
      }
      const after = await this.#fileEvidence(payload.path);
      if (
        after.dev !== opened.dev || after.ino !== opened.ino || after.mtimeMs !== opened.mtimeMs ||
        after.size !== opened.size
      ) throw new Error("messages_attachment_file_changed");
      const mimeType = detectedMime(Buffer.concat(sniff));
      if (!mimeCompatible(payload.mimeType, mimeType)) {
        throw new Error("messages_attachment_mime_mismatch");
      }
      await target.close();
      target = undefined;
      await source.close();
      source = undefined;
      return {
        dispose: async () => await rm(directory, { force: true, recursive: true }),
        mimeType: mimeType ?? payload.mimeType,
        name: payload.name,
        path: targetPath,
        sha256: digest.digest("hex"),
        sizeBytes: payload.size,
      };
    } catch (error) {
      await target?.close().catch(() => undefined);
      await source?.close().catch(() => undefined);
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  async #qualifiedScratchRoot(): Promise<string> {
    await mkdir(this.#scratchRoot, { mode: 0o700, recursive: true });
    const metadata = await lstat(this.#scratchRoot);
    if (
      !metadata.isDirectory() || metadata.isSymbolicLink() ||
      !ownedByCurrentUser(metadata.uid) || (metadata.mode & 0o077) !== 0
    ) throw new Error("messages_attachment_scratch_unsafe");
    return await realpath(this.#scratchRoot);
  }

  #capabilityUsage(scope: ConversationPayload): CapabilityUsage {
    this.#pruneUsage();
    const usage = this.#usage.get(scope.capabilityId);
    if (usage === undefined || usage.expiresAt !== scope.expiresAt) {
      throw new Error("messages_conversation_reference_invalid");
    }
    return usage;
  }

  #pruneUsage(): void {
    const now = this.#now();
    for (const [id, usage] of this.#usage) {
      if (usage.expiresAt <= now) this.#usage.delete(id);
    }
  }

  #seal(payload: unknown, kind: "attachment" | "conversation" | "history"): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`pronto/messages/${kind}/v1`, "utf8"));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
  }

  #open<T>(
    token: string,
    kind: "attachment" | "conversation" | "history",
    validate: (value: unknown) => value is T,
  ): T {
    try {
      const sealed = Buffer.from(token, "base64url");
      if (sealed.length < 29 || sealed.toString("base64url") !== token) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.#key, sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(`pronto/messages/${kind}/v1`, "utf8"));
      decipher.setAuthTag(sealed.subarray(12, 28));
      const value = JSON.parse(Buffer.concat([
        decipher.update(sealed.subarray(28)),
        decipher.final(),
      ]).toString("utf8"));
      if (!validate(value)) throw new Error();
      return value;
    } catch {
      throw new Error(`messages_${kind}_reference_invalid`);
    }
  }
}
