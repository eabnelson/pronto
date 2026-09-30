import { chmod, mkdir } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  MINIMUM_WACLI_VERSION,
  WHATSAPP_PROVIDER,
  type CreateProntoWhatsappOptions,
  type ProntoWhatsapp,
  type WhatsappConversationFacts,
  type WhatsappConversationReference,
  type WhatsappDeliveryOutcome,
  type WhatsappEvent,
  type WhatsappHealth,
  type WhatsappLinkStep,
  type WhatsappPresence,
  type WhatsappQualification,
  type WhatsappRecoveryOutcome,
  type WhatsappSubscription,
  type MaterializedWhatsappAttachment,
} from "../types.js";
import { downloadAttachment } from "./attachment.js";
import { linkSteps } from "./link.js";
import {
  canonicalJid,
  deliveryKey,
  fromStoredRow,
  fromWebhook,
  jidUser,
  type RawMessage,
} from "./normalize.js";
import { describeFailure, isRecord, parseEnvelope, runCommand, type CommandResult } from "./process.js";
import { ReferenceSigner } from "./reference.js";
import { DeliveryState } from "./state.js";
import { SyncSupervisor } from "./supervisor.js";
import { DEFAULT_TUNING, type Tuning } from "./tuning.js";
import { compareVersions, parseVersion } from "./version.js";
import { startWebhookServer, type WebhookServer } from "./webhook-server.js";

const DAY_MS = 24 * 60 * 60_000;
const MAX_HISTORY = 100;
const MAX_REPLY_CHARS = 65_536;
const RETRYABLE_SEND = /store is locked|not connected|delegate unavailable|another wacli is running/i;
const AMBIGUOUS_SEND = /timeout|timed out|deadline exceeded|context canceled/i;

interface Limits {
  readonly maxAgeMs: number;
  readonly maxLiveAgeMs: number;
  readonly maxMessages: number;
}

type SubscribeInput = Parameters<ProntoWhatsapp["subscribe"]>[0];

export function createModule(options: CreateProntoWhatsappOptions, tuning: Partial<Tuning> = {}): ProntoWhatsapp {
  return new WhatsappModule(options, { ...DEFAULT_TUNING, ...tuning });
}

class WhatsappModule implements ProntoWhatsapp {
  readonly presence?: WhatsappPresence;
  readonly #wacliPath: string;
  readonly #storeDir: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #attachmentsDir: string;
  readonly #limits: Limits;
  readonly #signer: ReferenceSigner;
  readonly #state: DeliveryState;
  readonly #tuning: Tuning;
  readonly #ownerCache = new Map<string, { readonly at: number; readonly participated: boolean }>();
  readonly #linkControllers = new Set<AbortController>();
  #linkedJid: string | null = null;
  #linkedLidUser: string | null = null;
  #subscription: Subscription | null = null;
  #closed = false;

  constructor(options: CreateProntoWhatsappOptions, tuning: Tuning) {
    if (typeof options.wacliPath !== "string" || options.wacliPath.trim() === "") {
      throw new Error("wacliPath is required");
    }
    if (!isAbsolute(options.storeDir) || !isAbsolute(options.statePath)) {
      throw new Error("storeDir and statePath must be absolute paths");
    }
    if (typeof options.referenceKey !== "string" || options.referenceKey.length < 32) {
      throw new Error("referenceKey must be at least 32 characters");
    }
    this.#wacliPath = options.wacliPath;
    this.#storeDir = options.storeDir;
    const label = options.deviceLabel?.trim();
    this.#env = label === undefined || label === "" ? process.env : { ...process.env, WACLI_DEVICE_LABEL: label };
    if (options.attachmentsDir !== undefined && !isAbsolute(options.attachmentsDir)) {
      throw new Error("attachmentsDir must be an absolute path");
    }
    this.#attachmentsDir = options.attachmentsDir ??
      join(tmpdir(), `pronto-whatsapp-attachments-${userInfo().uid}`);
    this.#tuning = tuning;
    this.#limits = {
      maxAgeMs: positive(options.recoveryLimits?.maxAgeMs, DAY_MS, "recoveryLimits.maxAgeMs"),
      maxLiveAgeMs: positive(options.recoveryLimits?.maxLiveAgeMs, 5 * 60_000, "recoveryLimits.maxLiveAgeMs"),
      maxMessages: Math.floor(positive(options.recoveryLimits?.maxMessages, 500, "recoveryLimits.maxMessages")),
    };
    this.#signer = new ReferenceSigner(
      options.referenceKey,
      positive(options.scopeLimits?.ttlMs, DAY_MS, "scopeLimits.ttlMs"),
      () => Date.now(),
    );
    this.#state = new DeliveryState(options.statePath);
    if (options.presence === true) {
      this.presence = { setTyping: (conversation, typing) => this.#setTyping(conversation, typing) };
    }
  }

  get limits(): Limits {
    return this.#limits;
  }

  get state(): DeliveryState {
    return this.#state;
  }

  get env(): NodeJS.ProcessEnv {
    return this.#env;
  }

  get tuning(): Tuning {
    return this.#tuning;
  }

  async qualify(): Promise<WhatsappQualification> {
    const wacliVersion = await this.#wacliVersion();
    const linkedJid = await this.#authStatus();
    return linkedJid === null
      ? { status: "needs_link", wacliVersion }
      : { linkedJid, status: "ready", wacliVersion };
  }

  async subscribe(input: SubscribeInput): Promise<WhatsappSubscription> {
    if (this.#closed) throw new Error("pronto-whatsapp is closed");
    if (this.#subscription !== null && !this.#subscription.ended) {
      throw new Error("A WhatsApp subscription is already active");
    }
    await this.#ensureStoreDir();
    await this.#state.load();
    const linkedJid = await this.#authStatus();
    const subscription = new Subscription(this, input);
    this.#subscription = subscription;
    if (linkedJid === null) {
      subscription.reportHealth({ state: "needs_link" });
      subscription.end();
      return subscription.handle;
    }
    await subscription.start(this.#wacliPath, this.#storeDir);
    return subscription.handle;
  }

  async history(input: Parameters<ProntoWhatsapp["history"]>[0]): Promise<WhatsappEvent[]> {
    const chatJid = this.#signer.verify(input.conversation);
    await this.#ensureLinkedJid();
    const limit = Math.min(MAX_HISTORY, Math.floor(input.limit));
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const result = await this.readMessages([`--chat=${chatJid}`, `--limit=${limit}`]);
    if (!Array.isArray(result)) throw new Error("WhatsApp history is unavailable");
    const messages = result
      .map(fromStoredRow)
      .filter((message): message is RawMessage => message !== null && message.chatJid === chatJid)
      .reverse();
    const participated = messages.some((message) => message.fromMe) || await this.ownerParticipated(chatJid);
    const conversation = this.#signer.issue(chatJid);
    return messages.map((message) => this.buildEvent(message, "recovered", {
      isGroup: chatJid.endsWith("@g.us"),
      ownerParticipated: participated,
      selfChat: this.isSelfChat(chatJid),
    }, conversation));
  }

  async reply(input: Parameters<ProntoWhatsapp["reply"]>[0]): Promise<WhatsappDeliveryOutcome> {
    const chatJid = this.#signer.verify(input.conversation);
    if (typeof input.text !== "string" || input.text.trim() === "") {
      return { reason: "Reply text is empty", retryable: false, status: "failed" };
    }
    if (input.text.length > MAX_REPLY_CHARS) {
      return { reason: "Reply text is too long", retryable: false, status: "failed" };
    }
    const readiness = await this.#awaitDelegate();
    if (readiness !== null) return readiness;
    await this.#ensureLinkedJid();
    const args = [
      "--store", this.#storeDir, "--json", `--timeout=${Math.max(1, Math.floor(this.#tuning.sendTimeoutMs / 1000) - 5)}s`,
      "send", "text", `--to=${chatJid}`, `--message=${input.text}`,
    ];
    if (this.isSelfChat(chatJid)) args.push("--allow-self");
    if (input.quote !== undefined) {
      args.push(`--reply-to=${input.quote.providerMessageId}`);
      const sender = input.quote.sender ?? null;
      if (sender !== null && sender.trim() !== "") args.push(`--reply-to-sender=${canonicalJid(sender)}`);
    }
    const result = await runCommand(this.#wacliPath, args, { env: this.#env, timeoutMs: this.#tuning.sendTimeoutMs });
    const outcome = sendOutcome(result);
    if (outcome.status === "confirmed") {
      await this.#state.load().then(async () => {
        await this.#state.markDelivered(`${chatJid}|${outcome.providerMessageId}`, null);
        await this.#state.markDelivered(`sent|${outcome.providerMessageId}`, null);
      }).catch(() => undefined);
    }
    return outcome;
  }

  async materializeAttachment(
    input: Parameters<ProntoWhatsapp["materializeAttachment"]>[0],
  ): Promise<MaterializedWhatsappAttachment> {
    const chatJid = this.#signer.verify(input.conversation);
    const row = await this.#readMessage(chatJid, input.providerMessageId);
    if (row === null || row.media === null) {
      throw new Error("WhatsApp message has no downloadable attachment");
    }
    return await downloadAttachment({
      attachmentsDir: this.#attachmentsDir,
      chatJid,
      declaredMimeType: row.media.mimeType,
      maxBytes: input.maxBytes,
      messageId: input.providerMessageId,
      storeDir: this.#storeDir,
      env: this.#env,
      timeoutMs: this.#tuning.attachmentTimeoutMs,
      wacliPath: this.#wacliPath,
    });
  }

  async *link(input: Parameters<ProntoWhatsapp["link"]>[0] = {}): AsyncGenerator<WhatsappLinkStep> {
    if (this.#subscription !== null && !this.#subscription.ended) {
      yield { reason: "Close the WhatsApp subscription before linking", type: "failed" };
      return;
    }
    await this.#ensureStoreDir();
    const controller = new AbortController();
    const forward = () => controller.abort();
    input.signal?.addEventListener("abort", forward, { once: true });
    if (input.signal?.aborted) controller.abort();
    this.#linkControllers.add(controller);
    try {
      yield* linkSteps({
        closeGraceMs: this.#tuning.closeGraceMs,
        retryDelayMs: this.#tuning.linkRetryDelayMs,
        env: this.#env,
        linkedJid: () => this.#authStatus(),
        ...(input.phone === undefined ? {} : { phone: input.phone }),
        signal: controller.signal,
        storeDir: this.#storeDir,
        wacliPath: this.#wacliPath,
      });
    } finally {
      input.signal?.removeEventListener("abort", forward);
      this.#linkControllers.delete(controller);
    }
  }

  async unlink(): Promise<void> {
    await this.#subscription?.terminate();
    const result = await runCommand(
      this.#wacliPath,
      ["--store", this.#storeDir, "auth", "logout"],
      { env: this.#env, timeoutMs: this.#tuning.logoutTimeoutMs },
    );
    this.#linkedJid = null;
    this.#linkedLidUser = null;
    this.#ownerCache.clear();
    if (result.code === 0) return;
    // wacli clears the local session even when WhatsApp's servers are slow to confirm,
    // so a failed or timed-out logout still counts when this Mac is no longer linked.
    const stillLinked = await this.#authStatus().catch(() => "unknown");
    if (stillLinked !== null) throw new Error(`wacli auth logout failed: ${describeFailure(result)}`);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#linkControllers) controller.abort();
    await this.#subscription?.close();
  }

  isSelfChat(chatJid: string): boolean {
    const user = jidUser(chatJid);
    if (chatJid.endsWith("@s.whatsapp.net")) {
      return this.#linkedJid !== null && user === jidUser(this.#linkedJid);
    }
    return chatJid.endsWith("@lid") && this.#linkedLidUser !== null && user === this.#linkedLidUser;
  }

  /** A self-chat message the owner sent from another device reveals the account's LID. */
  learnFromMessage(message: RawMessage): void {
    if (!message.fromMe) return;
    this.#ownerCache.set(message.chatJid, { at: Date.now(), participated: true });
    if (message.senderJid?.endsWith("@lid") && message.chatJid === message.senderJid) {
      this.#linkedLidUser = jidUser(message.senderJid);
    }
  }

  async ownerParticipated(chatJid: string): Promise<boolean> {
    const cached = this.#ownerCache.get(chatJid);
    if (cached?.participated) return true;
    if (cached !== undefined && Date.now() - cached.at < this.#tuning.negativeOwnerCacheMs) return false;
    const rows = await this.readMessages([`--chat=${chatJid}`, "--from-me", "--limit=1"]);
    if (!Array.isArray(rows)) return false;
    const participated = rows.length > 0;
    this.#ownerCache.set(chatJid, { at: Date.now(), participated });
    return participated;
  }

  async facts(message: RawMessage): Promise<WhatsappConversationFacts> {
    const selfChat = this.isSelfChat(message.chatJid);
    return {
      isGroup: message.chatJid.endsWith("@g.us"),
      ownerParticipated: message.fromMe || selfChat || await this.ownerParticipated(message.chatJid),
      selfChat,
    };
  }

  buildEvent(
    message: RawMessage,
    origin: WhatsappEvent["origin"],
    facts: WhatsappConversationFacts,
    conversation: WhatsappConversationReference = this.#signer.issue(message.chatJid),
  ): WhatsappEvent {
    return {
      conversation,
      conversationFacts: facts,
      message: {
        fromMe: message.fromMe,
        kind: message.kind,
        media: message.media,
        occurredAt: new Date(message.occurredAtMs).toISOString(),
        providerMessageId: message.id,
        replyToProviderMessageId: message.replyToId,
        sender: message.fromMe ? this.#linkedJid ?? message.senderJid : message.senderJid,
        senderName: message.senderName,
        text: message.text,
      },
      origin,
      provider: WHATSAPP_PROVIDER,
      version: 1,
    };
  }

  /** `messages list` rows, or null when the read failed. */
  async readMessages(filters: readonly string[]): Promise<unknown[] | null> {
    const result = await runCommand(
      this.#wacliPath,
      ["--store", this.#storeDir, "--read-only", "--json", "messages", "list", ...filters],
      { env: this.#env, timeoutMs: this.#tuning.commandTimeoutMs },
    );
    const envelope = parseEnvelope(result);
    if (result.code !== 0 || envelope === null || !envelope.success || !isRecord(envelope.data)) return null;
    return Array.isArray(envelope.data.messages) ? envelope.data.messages : [];
  }

  async #readMessage(chatJid: string, messageId: string): Promise<RawMessage | null> {
    const result = await runCommand(
      this.#wacliPath,
      ["--store", this.#storeDir, "--read-only", "--json", "messages", "show", `--chat=${chatJid}`, `--id=${messageId}`],
      { env: this.#env, timeoutMs: this.#tuning.commandTimeoutMs },
    );
    const envelope = parseEnvelope(result);
    if (result.code !== 0 || envelope === null || !envelope.success) return null;
    const message = fromStoredRow(envelope.data);
    return message !== null && message.chatJid === chatJid && message.id === messageId ? message : null;
  }

  async #setTyping(conversation: WhatsappConversationReference, typing: boolean): Promise<void> {
    const chatJid = this.#signer.verify(conversation);
    const subscription = this.#subscription;
    if (subscription === null || subscription.ended) return;
    if (await subscription.waitReady(0) !== "ready") return;
    await runCommand(
      this.#wacliPath,
      ["--store", this.#storeDir, "presence", typing ? "typing" : "paused", `--to=${chatJid}`],
      { env: this.#env, timeoutMs: this.#tuning.presenceTimeoutMs },
    ).catch(() => undefined);
  }

  async #awaitDelegate(): Promise<WhatsappDeliveryOutcome | null> {
    const subscription = this.#subscription;
    if (subscription === null || subscription.closedByConsumer) return null;
    if (subscription.ended) {
      return { reason: "WhatsApp needs to be linked again", retryable: false, status: "failed" };
    }
    const readiness = await subscription.waitReady(this.#tuning.readinessTimeoutMs);
    if (readiness === "ready") return null;
    return {
      reason: readiness === "timeout" ? "WhatsApp is not connected yet" : "WhatsApp subscription ended",
      retryable: readiness === "timeout",
      status: "failed",
    };
  }

  async #wacliVersion(): Promise<string> {
    const result = await runCommand(this.#wacliPath, ["version"], { env: this.#env, timeoutMs: this.#tuning.commandTimeoutMs });
    if (result.code !== 0) throw new Error(`wacli is unavailable: ${describeFailure(result)}`);
    const version = parseVersion(result.stdout);
    if (version === null) throw new Error("Could not determine the wacli version");
    if (compareVersions(version, MINIMUM_WACLI_VERSION) < 0) {
      throw new Error(
        `wacli ${version} is older than the required ${MINIMUM_WACLI_VERSION}; run \`brew upgrade wacli\``,
      );
    }
    return version;
  }

  /** Self-chat detection and `fromMe` senders need the linked account, even before `qualify()`. */
  async #ensureLinkedJid(): Promise<void> {
    if (this.#linkedJid !== null) return;
    await this.#authStatus().catch(() => null);
  }

  async #authStatus(): Promise<string | null> {
    await this.#ensureStoreDir();
    const result = await runCommand(
      this.#wacliPath,
      ["--store", this.#storeDir, "--read-only", "--json", "auth", "status"],
      { env: this.#env, timeoutMs: this.#tuning.commandTimeoutMs },
    );
    const envelope = parseEnvelope(result);
    if (envelope === null || !envelope.success || !isRecord(envelope.data)) {
      throw new Error(`wacli auth status failed: ${describeFailure(result)}`);
    }
    const jid = envelope.data.linked_jid;
    if (envelope.data.authenticated !== true || typeof jid !== "string" || jid === "") {
      this.#linkedJid = null;
      return null;
    }
    this.#linkedJid = canonicalJid(jid);
    return this.#linkedJid;
  }

  async #ensureStoreDir(): Promise<void> {
    const created = await mkdir(this.#storeDir, { mode: 0o700, recursive: true });
    if (created !== undefined) await chmod(this.#storeDir, 0o700);
  }
}

class Subscription {
  readonly handle: WhatsappSubscription;
  #ended = false;
  #closedByConsumer = false;
  #resolveTerminated!: () => void;
  #tail: Promise<void> = Promise.resolve();
  #sweepQueued = false;
  #supervisor: SyncSupervisor | null = null;
  #server: WebhookServer | null = null;
  #interval: NodeJS.Timeout | null = null;
  #startFloorMs: number | null = null;

  constructor(private readonly module: WhatsappModule, private readonly input: SubscribeInput) {
    const terminated = new Promise<void>((resolve) => {
      this.#resolveTerminated = resolve;
    });
    this.handle = { close: () => this.close(), terminated };
  }

  get ended(): boolean {
    return this.#ended;
  }

  get closedByConsumer(): boolean {
    return this.#closedByConsumer;
  }

  async start(wacliPath: string, storeDir: string): Promise<void> {
    await this.module.state.initializeWatermark(Date.now());
    this.#startFloorMs = this.module.state.sweepFloorMs();
    this.#server = await startWebhookServer((payload) => this.#onWebhook(payload));
    this.#sweep("start");
    this.#supervisor = new SyncSupervisor({
      hooks: {
        onHealth: (health) => this.reportHealth(health),
        onOfflineSyncCompleted: () => this.#sweep("offline"),
        onTerminated: () => {
          void this.#shutdown().then(() => this.end());
        },
      },
      env: this.module.env,
      storeDir,
      tuning: this.module.tuning,
      wacliPath,
      webhookSecret: this.#server.secret,
      webhookUrl: this.#server.url,
    });
    this.#supervisor.start();
    this.#interval = setInterval(() => {
      if (this.#supervisor?.connected) this.#sweep("interval");
    }, this.module.tuning.liveSweepIntervalMs);
    this.#interval.unref();
  }

  async waitReady(timeoutMs: number): Promise<"ready" | "stopped" | "timeout"> {
    if (this.#ended || this.#supervisor === null) return "stopped";
    return await this.#supervisor.waitReady(timeoutMs);
  }

  reportHealth(health: WhatsappHealth): void {
    const callback = this.input.onHealth;
    if (callback === undefined) return;
    void Promise.resolve().then(() => callback(health)).catch(() => undefined);
  }

  end(): void {
    this.#ended = true;
    this.#resolveTerminated();
  }

  /** Ends the subscription as if WhatsApp had unlinked the device. */
  async terminate(): Promise<void> {
    if (this.#ended) return;
    await this.#shutdown();
    this.reportHealth({ state: "needs_link" });
    this.end();
  }

  async close(): Promise<void> {
    this.#closedByConsumer = true;
    await this.#shutdown();
    this.end();
  }

  async #shutdown(): Promise<void> {
    this.#ended = true;
    if (this.#interval !== null) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
    await this.#server?.close();
    await this.#supervisor?.stop();
    await this.#tail;
  }

  #enqueue(task: () => Promise<void>): void {
    this.#tail = this.#tail.then(async () => {
      if (this.#ended) return;
      await task();
    }).catch(() => undefined);
  }

  #onWebhook(payload: unknown): void {
    if (this.#ended) return;
    const arrivedAt = Date.now();
    const message = fromWebhook(payload);
    if (message === null) return;
    this.module.learnFromMessage(message);
    this.#enqueue(async () => {
      const key = deliveryKey(message);
      if (this.module.state.has(key)) return;
      if (arrivedAt - message.occurredAtMs > this.module.limits.maxLiveAgeMs) {
        if (this.#recoverable(message)) await this.module.state.markUndelivered(key, message.occurredAtMs);
        return;
      }
      await this.#deliver(message, "live");
    });
  }

  #recoverable(message: RawMessage): boolean {
    const floor = this.#startFloorMs ?? Date.now();
    return message.occurredAtMs >= floor - 1_000
      && message.occurredAtMs >= Date.now() - this.module.limits.maxAgeMs;
  }

  async #deliver(message: RawMessage, origin: WhatsappEvent["origin"]): Promise<boolean> {
    const key = deliveryKey(message);
    const event = this.module.buildEvent(message, origin, await this.module.facts(message));
    try {
      await this.input.onEvent(event);
    } catch {
      if (this.#recoverable(message)) await this.module.state.markUndelivered(key, message.occurredAtMs);
      return false;
    }
    await this.module.state.markDelivered(key, message.occurredAtMs);
    return true;
  }

  #sweep(reason: "interval" | "offline" | "start"): void {
    if (this.#ended || this.#sweepQueued) return;
    this.#sweepQueued = true;
    this.#enqueue(async () => {
      this.#sweepQueued = false;
      const outcome = await this.#runSweep();
      if (reason === "interval" && outcome.status === "recovered" && outcome.messages === 0) return;
      const callback = this.input.onRecovery;
      if (callback !== undefined) await Promise.resolve(callback(outcome)).catch(() => undefined);
    });
  }

  async #runSweep(): Promise<WhatsappRecoveryOutcome> {
    const { maxAgeMs, maxMessages } = this.module.limits;
    const state = this.module.state;
    const now = Date.now();
    await state.pruneUndelivered(now - maxAgeMs);
    const floor = state.sweepFloorMs() ?? now;
    // `--after` is exclusive at whole-second precision, so step back to keep same-second messages.
    const afterMs = Math.floor(Math.max(floor - 1_000, now - maxAgeMs) / 1_000) * 1_000;
    const after = new Date(afterMs).toISOString().replace(".000Z", "Z");
    const rows = await this.module.readMessages([`--after=${after}`, "--asc", `--limit=${maxMessages}`]);
    if (rows === null) return { messages: 0, reason: "sweep-failed", status: "degraded" };
    let delivered = 0;
    for (const row of rows) {
      if (this.#ended) break;
      const message = fromStoredRow(row);
      if (message === null) continue;
      if (message.occurredAtMs < Date.now() - maxAgeMs) continue;
      if (state.has(deliveryKey(message))) continue;
      if (message.fromMe && state.has(`sent|${message.id}`)) continue;
      this.module.learnFromMessage(message);
      if (await this.#deliver(message, "recovered")) delivered += 1;
    }
    return rows.length >= maxMessages
      ? { messages: delivered, reason: "sweep-limit", status: "degraded" }
      : { messages: delivered, status: "recovered" };
  }
}

function sendOutcome(result: CommandResult): WhatsappDeliveryOutcome {
  if (result.spawnError !== null) {
    return { reason: `wacli could not start: ${result.spawnError}`, retryable: false, status: "failed" };
  }
  if (result.timedOut) return { status: "ambiguous" };
  const envelope = parseEnvelope(result);
  if (envelope === null) return { status: "ambiguous" };
  if (envelope.success) {
    const data = isRecord(envelope.data) ? envelope.data : {};
    return typeof data.id === "string" && data.id !== "" && data.sent !== false
      ? { providerMessageId: data.id, status: "confirmed" }
      : { status: "ambiguous" };
  }
  const reason = envelope.error ?? "wacli send failed";
  if (RETRYABLE_SEND.test(reason)) return { reason, retryable: true, status: "failed" };
  if (AMBIGUOUS_SEND.test(reason)) return { status: "ambiguous" };
  return { reason, retryable: false, status: "failed" };
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}
