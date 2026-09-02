import {
  ResilientRpcClient,
  RpcRequestError,
  RpcSubmissionUncertainError,
  type RpcNotification,
} from "./internal/rpc.js";
import { createHash } from "node:crypto";
import {
  databasePath,
  normalizeConversationFacts,
  normalizeEvent,
  qualify,
  record,
} from "./internal/normalize.js";
import { databaseGeneration } from "./internal/generation.js";
import {
  ConversationReferenceExpiredError,
  ScopedMessagesAccess,
} from "./internal/scoped.js";
import {
  MemoryCheckpointStore,
  ProviderStateStore,
  type CheckpointStore,
  type ProviderCheckpoint,
} from "./internal/state.js";
import type {
  DeliveryOutcome,
  CreateProntoMessagesOptions,
  MaterializedAttachment,
  MessagesDiagnostics,
  MessagesEvent,
  MessagesHistoryPage,
  MessagesQualification,
  MessagesRecoveryOutcome,
  MessagesRecoveryReason,
  MessagesSubscription,
  ProntoMessages,
} from "./types.js";

export type {
  ConversationFacts,
  ConversationReference,
  AttachmentReference,
  CreateProntoMessagesOptions,
  DeliveryOutcome,
  MessagesAttachment,
  MessagesEvent,
  MessagesHistoryBudget,
  MessagesHistoryPage,
  MessagesDiagnostics,
  MessagesQualification,
  MessagesRecoveryOutcome,
  MessagesRecoveryLimits,
  MessagesRecoveryReason,
  MessagesScopeLimits,
  MessagesSubscription,
  ProntoMessages,
  MaterializedAttachment,
} from "./types.js";

function messageDateMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMirrorPair(message: MessagesEvent, original: MessagesEvent): boolean {
  if (
    original.conversation.chatId !== message.conversation.chatId ||
    !original.message.fromMe ||
    original.message.text !== message.message.text
  ) {
    return false;
  }
  const rowDistance = message.message.rowId - original.message.rowId;
  if (rowDistance < 1) return false;
  const messageTime = messageDateMs(message.message.occurredAt);
  const originalTime = messageDateMs(original.message.occurredAt);
  return (
    messageTime !== null &&
    originalTime !== null &&
    messageTime <= originalTime &&
    originalTime - messageTime <= 1_000
  );
}

class RecoveryBoundaryError extends Error {
  constructor(readonly reason: MessagesRecoveryReason, readonly rows: number) {
    super(reason);
  }
}

interface RecoveryBudget {
  readonly deadline: number;
  readonly rows: number;
}

function isGenerationBoundary(error: unknown): error is RecoveryBoundaryError {
  return error instanceof RecoveryBoundaryError &&
    (error.reason === "database-generation-changed" ||
      error.reason === "database-generation-unavailable");
}

class ProntoMessagesClient implements ProntoMessages {
  readonly #rpc: ResilientRpcClient;
  readonly #scoped: ScopedMessagesAccess;
  readonly #recentOutgoing = new Map<string, MessagesEvent>();
  readonly #inFlightDeliveries = new Map<string, Promise<void>>();
  readonly #state: CheckpointStore;
  readonly #limits: { readonly maxAgeMs: number; readonly maxDurationMs: number; readonly maxRows: number };
  #diagnostics: MessagesDiagnostics = {
    attempt: 0,
    catchUpRows: 0,
    restartCount: 0,
    state: "starting",
  };
  #closed = false;
  #databasePath: string | undefined;
  #subscriptionActive = false;

  constructor(input: CreateProntoMessagesOptions) {
    this.#limits = {
      maxAgeMs: input.recoveryLimits?.maxAgeMs ?? 24 * 60 * 60 * 1_000,
      maxDurationMs: input.recoveryLimits?.maxDurationMs ?? 30_000,
      maxRows: input.recoveryLimits?.maxRows ?? 10_000,
    };
    if (Object.values(this.#limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error("messages_recovery_limits_invalid");
    }
    this.#state = input.statePath === undefined
      ? new MemoryCheckpointStore()
      : new ProviderStateStore(input.statePath, {
        ...(input.legacyUnscopedCursor === undefined
          ? {}
          : { legacyUnscopedCursor: input.legacyUnscopedCursor }),
      });
    this.#rpc = ResilientRpcClient.spawn(input.imsgPath);
    this.#scoped = new ScopedMessagesAccess({
      ...(input.attachmentsRoot === undefined ? {} : { attachmentsRoot: input.attachmentsRoot }),
      generation: async () => await this.#refreshGeneration(),
      ...(input.scopeLimits === undefined ? {} : { limits: input.scopeLimits }),
      ...(input.referenceKey === undefined ? {} : { referenceKey: input.referenceKey }),
      rpc: this.#rpc,
      ...(input.scratchRoot === undefined ? {} : { scratchRoot: input.scratchRoot }),
    });
  }

  async qualify(): Promise<MessagesQualification> {
    const snapshot = await this.#rpc.request("initialize", { protocol_version: 1 }, 10_000);
    const path = databasePath(snapshot);
    this.#databasePath = path;
    return {
      ...qualify(snapshot),
      databaseGeneration: await databaseGeneration(path),
    };
  }

  diagnostics(): MessagesDiagnostics {
    const rpc = this.#rpc.diagnostics();
    return {
      ...this.#diagnostics,
      attempt: rpc.attempt,
      restartCount: rpc.restartCount,
      state: this.#closed ? "closed" : rpc.state === "recovering" ? "recovering" : this.#diagnostics.state,
      ...(rpc.nextRetryAt === undefined ? {} : { nextRetryAt: rpc.nextRetryAt }),
    };
  }

  async history(
    input: Parameters<ProntoMessages["history"]>[0],
  ): Promise<MessagesHistoryPage> {
    return await this.#scoped.history(input);
  }

  async materializeAttachment(
    input: Parameters<ProntoMessages["materializeAttachment"]>[0],
  ): Promise<MaterializedAttachment> {
    return await this.#scoped.materializeAttachment(input);
  }

  async subscribe(
    input: Parameters<ProntoMessages["subscribe"]>[0],
  ): Promise<MessagesSubscription> {
    if (this.#subscriptionActive) throw new Error("messages_subscription_already_active");
    this.#subscriptionActive = true;
    let subscriptionId: number | null = null;
    let databaseGeneration: string;
    let closed = false;
    let signalClosed!: () => void;
    const closedSignal = new Promise<void>((resolve) => {
      signalClosed = resolve;
    });
    let queue = Promise.resolve();
    const enqueue = (operation: () => Promise<void>): void => {
      queue = queue.then(operation, operation).catch(() => {
        this.#diagnostics = { ...this.#diagnostics, state: "degraded" };
      });
    };
    const pendingNotifications: RpcNotification[] = [];
    const detachProvider = async (): Promise<void> => {
      const active = subscriptionId;
      subscriptionId = null;
      if (active !== null) {
        await this.#rpc.request("watch.unsubscribe", { subscription: active }).catch(() => undefined);
      }
    };
    const report = async (outcome: MessagesRecoveryOutcome): Promise<void> => {
      if (outcome.status === "recovered") {
        const { recoveryReason: _recoveredReason, ...diagnostics } = this.#diagnostics;
        this.#diagnostics = {
          ...diagnostics,
          catchUpRows: this.#diagnostics.catchUpRows + outcome.rows,
          state: "ready",
        };
      } else {
        this.#diagnostics = {
          ...this.#diagnostics,
          catchUpRows: this.#diagnostics.catchUpRows + outcome.rows,
          recoveryReason: outcome.reason,
          state: "degraded",
        };
      }
      await Promise.resolve(input.onRecovery?.(outcome)).catch(() => undefined);
    };
    const subscribeProvider = async (useCheckpoint: boolean): Promise<void> => {
      if (closed) return;
      await detachProvider();
      if (closed) return;
      const checkpoint = useCheckpoint
        ? await this.#state.checkpoint(databaseGeneration)
        : undefined;
      const result = record(await this.#rpc.request("watch.subscribe", {
        attachments: true,
        buffer_limit: 256,
        include_reactions: true,
        ...(checkpoint === undefined ? {} : { since_rowid: checkpoint.rowId }),
      }));
      if (typeof result.subscription !== "number" || !Number.isSafeInteger(result.subscription)) {
        throw new Error("imsg returned an invalid watch subscription");
      }
      if (closed) {
        await this.#rpc.request("watch.unsubscribe", { subscription: result.subscription })
          .catch(() => undefined);
        return;
      }
      subscriptionId = result.subscription;
      for (const notification of pendingNotifications.splice(0)) {
        enqueue(async () => await handleNotification(notification));
      }
    };
    const recover = async (boundaryReason?: MessagesRecoveryReason): Promise<void> => {
      if (closed) return;
      const previous = await this.#state.currentCheckpoint();
      const qualification = await this.qualify();
      if (closed) return;
      databaseGeneration = qualification.databaseGeneration;
      this.#diagnostics = {
        ...this.#diagnostics,
        databaseGenerationDigest: qualification.databaseGeneration.slice(0, 16),
        state: "starting",
      };
      if (boundaryReason !== undefined) {
        await report({
          action: "live-events-only",
          reason: boundaryReason,
          rows: 0,
          status: "degraded",
        });
        await subscribeProvider(false);
        return;
      }
      if (
        previous !== undefined &&
        previous.databaseGeneration !== qualification.databaseGeneration
      ) {
        await report({
          action: "live-events-only",
          reason: "database-generation-changed",
          rows: 0,
          status: "degraded",
        });
        await subscribeProvider(false);
        return;
      }
      if (previous !== undefined && !(await this.#checkpointWitnessMatches(previous))) {
        await report({
          action: "live-events-only",
          reason: "database-generation-changed",
          rows: 0,
          status: "degraded",
        });
        await subscribeProvider(false);
        return;
      }
      if (previous !== undefined) {
        const outcome = await this.#catchUp(
          databaseGeneration,
          input,
          scheduleDeferredDelivery,
        );
        if (outcome.status === "degraded" && outcome.reason === "database-generation-changed") {
          databaseGeneration = (await this.qualify()).databaseGeneration;
        }
        await report(outcome);
        if (this.#inFlightDeliveries.size > 0) return;
      }
      await subscribeProvider(this.#diagnostics.state !== "degraded");
      if (this.#diagnostics.state !== "degraded") {
        this.#diagnostics = { ...this.#diagnostics, state: "ready" };
      }
    };
    let recoveryTail = Promise.resolve();
    const recoverSerially = async (boundaryReason?: MessagesRecoveryReason): Promise<void> => {
      let release!: () => void;
      const previous = recoveryTail;
      recoveryTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        await recover(boundaryReason);
      } finally {
        release();
      }
    };
    const retryWhileOpen = async (
      operation: () => Promise<void>,
      onFirstFailure?: () => Promise<void>,
    ): Promise<void> => {
      let delayMs = 250;
      let firstFailure = true;
      while (!closed) {
        try {
          await operation();
          return;
        } catch {
          if (closed) return;
          this.#diagnostics = { ...this.#diagnostics, state: "recovering" };
          if (firstFailure) {
            firstFailure = false;
            await onFirstFailure?.();
          }
          await Promise.race([
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delayMs);
              timer.unref?.();
            }),
            closedSignal,
          ]);
          delayMs = Math.min(30_000, delayMs * 2);
        }
      }
    };
    const recoverUntilSubscribed = async (
      boundaryReason?: MessagesRecoveryReason,
    ): Promise<void> => {
      await retryWhileOpen(
        async () => await recoverSerially(boundaryReason),
        async () => await report({
          action: "live-events-only",
          reason: "provider-unavailable",
          rows: 0,
          status: "degraded",
        }),
      );
    };
    const retryFailedDelivery = async (
      rawMessage: Record<string, unknown>,
      generation: string,
    ): Promise<void> => {
      await retryWhileOpen(async () => {
        try {
          await this.#deliver(rawMessage, generation, input);
          await recoverUntilSubscribed();
        } catch (error) {
          if (isGenerationBoundary(error)) {
            await recoverUntilSubscribed(error.reason);
            return;
          }
          throw error;
        }
      });
    };
    const scheduleDeferredDelivery = (
      rawMessage: Record<string, unknown>,
      generation: string,
      error?: unknown,
    ): void => {
      const settle = async (): Promise<void> => {
        if (closed) return;
        await detachProvider();
        if (error === undefined) {
          await recoverUntilSubscribed();
        } else {
          await retryFailedDelivery(rawMessage, generation);
        }
      };
      enqueue(settle);
    };
    const handleNotification = async (notification: RpcNotification): Promise<void> => {
      if (closed) return;
      const params = record(notification.params);
      if (params.subscription !== subscriptionId) return;
      if (notification.method === "watch.overflow") {
        if (
          params.terminal === true &&
          typeof params.resume_after_rowid === "number" &&
          Number.isSafeInteger(params.resume_after_rowid)
        ) {
          await Promise.resolve(input.onOverflow?.(params.resume_after_rowid)).catch(() => undefined);
          subscriptionId = null;
          await recoverUntilSubscribed();
        }
        return;
      }
      if (notification.method !== "message") return;
      const rawMessage = record(params.message);
      let observedGeneration: string;
      try {
        observedGeneration = await this.#refreshGeneration();
      } catch {
        await report({
          action: "live-events-only",
          reason: "database-generation-unavailable",
          rows: 0,
          status: "degraded",
        });
        return;
      }
      if (observedGeneration !== databaseGeneration) {
        await detachProvider();
        await recoverUntilSubscribed("database-generation-changed");
        return;
      }
      try {
        await this.#deliver(rawMessage, databaseGeneration, input);
      } catch (error) {
        if (isGenerationBoundary(error)) {
          await detachProvider();
          await recoverUntilSubscribed(error.reason);
          return;
        }
        await detachProvider();
        await retryFailedDelivery(rawMessage, databaseGeneration);
        return;
      }
    };
    const dispose = this.#rpc.onNotification((notification) => {
      if (subscriptionId === null) {
        pendingNotifications.push(notification);
        return;
      }
      enqueue(async () => await handleNotification(notification));
    });
    const disposeRestart = this.#rpc.onRestart(() => {
      if (closed) return;
      subscriptionId = null;
      enqueue(async () => await recoverUntilSubscribed());
    });
    try {
      await recoverSerially();
      return {
        close: async () => {
          if (closed) return;
          closed = true;
          signalClosed();
          dispose();
          disposeRestart();
          await queue;
          await detachProvider();
          this.#subscriptionActive = false;
        },
        terminated: this.#rpc.terminated,
      };
    } catch (error) {
      dispose();
      disposeRestart();
      this.#subscriptionActive = false;
      throw error;
    }
  }

  async reply(input: Parameters<ProntoMessages["reply"]>[0]): Promise<DeliveryOutcome> {
    const conversation = await this.#scoped.conversation(input.conversation, true).catch((error) => {
      if (error instanceof ConversationReferenceExpiredError) {
        return null;
      }
      throw error;
    });
    if (conversation === null) return { retryable: false, status: "failed" };
    try {
      const result = record(await this.#rpc.request("send", {
        chat_id: conversation.chatId,
        text: input.text,
      }));
      if (result.ok !== true) return { retryable: false, status: "failed" };
      return typeof result.guid === "string" && result.guid !== ""
        ? { providerMessageId: result.guid, status: "confirmed" }
        : { status: "ambiguous" };
    } catch (error) {
      if (error instanceof RpcSubmissionUncertainError) return { status: "ambiguous" };
      if (!(error instanceof RpcRequestError)) return { retryable: false, status: "failed" };
      const data = record(error.data);
      return data.disposition === "may_have_completed" || data.disposition === "still_in_flight"
        ? { status: "ambiguous" }
        : { retryable: data.retry_safe === true, status: "failed" };
    }
  }

  async #deliver(
    rawMessage: Record<string, unknown>,
    generation: string,
    input: Parameters<ProntoMessages["subscribe"]>[0],
    budget?: RecoveryBudget,
    onDeferredSettlement?: (error?: unknown) => void,
  ): Promise<void> {
    const within = async <T>(operation: () => Promise<T>): Promise<T> => budget === undefined
      ? await operation()
      : await this.#withinDeadline(budget, operation);
    const chatId = rawMessage.chat_id;
    const rowId = rawMessage.id;
    if (
      typeof chatId !== "number" || !Number.isSafeInteger(chatId) || chatId <= 0 ||
      typeof rowId !== "number" || !Number.isSafeInteger(rowId) || rowId <= 0
    ) {
      return;
    }
    const checkpoint = await within(async () => await this.#state.checkpoint(generation));
    if (checkpoint !== undefined && rowId <= checkpoint.rowId) return;
    const stats = await within(async () => await this.#rpc.request(
      "messages.stats",
      { chat_id: chatId },
      budget === undefined ? 30_000 : this.#providerTimeout(budget),
    ));
    const event = normalizeEvent(rawMessage, normalizeConversationFacts(stats, chatId));
    if (event === null) return;
    const normalizedEvent: MessagesEvent = {
      ...event,
      message: {
        ...event.message,
        selfChatMirror: await this.#isSelfChatMirror(event, budget),
      },
    };
    const scopedEvent = await within(async () => await this.#scoped.decorateEvent(
      normalizedEvent,
      rawMessage,
      generation,
    ));
    this.#rememberOutgoing(scopedEvent);
    const deliveryKey = `${generation}:${rowId}`;
    const existingDelivery = this.#inFlightDeliveries.get(deliveryKey);
    if (existingDelivery !== undefined) {
      if (budget !== undefined) await within(async () => await existingDelivery);
      return;
    }
    const delivery = (async () => {
      await input.onEvent(scopedEvent);
      const observedGeneration = await this.#refreshGeneration();
      if (observedGeneration !== generation) {
        throw new RecoveryBoundaryError("database-generation-changed", budget?.rows ?? 0);
      }
      await this.#state.advance(generation, rowId, {
        providerMessageDigest: this.#providerMessageDigest(
          normalizedEvent.message.providerMessageId,
        ),
        rowId,
      });
    })();
    const trackedDelivery = delivery.finally(() => {
      if (this.#inFlightDeliveries.get(deliveryKey) === trackedDelivery) {
        this.#inFlightDeliveries.delete(deliveryKey);
      }
    });
    this.#inFlightDeliveries.set(deliveryKey, trackedDelivery);
    try {
      await within(async () => await trackedDelivery);
    } catch (error) {
      if (
        budget !== undefined &&
        error instanceof RecoveryBoundaryError &&
        error.reason === "duration-limit" &&
        onDeferredSettlement !== undefined
      ) {
        void trackedDelivery.then(
          () => onDeferredSettlement(),
          (deliveryError) => onDeferredSettlement(deliveryError),
        );
      }
      throw error;
    }
  }

  async #catchUp(
    generation: string,
    input: Parameters<ProntoMessages["subscribe"]>[0],
    onDeferredDelivery: (
      rawMessage: Record<string, unknown>,
      generation: string,
      error?: unknown,
    ) => void,
  ): Promise<MessagesRecoveryOutcome> {
    const checkpoint = await this.#state.checkpoint(generation);
    if (checkpoint === undefined) return { rows: 0, status: "recovered" };
    const startedAt = Date.now();
    const deadline = startedAt + this.#limits.maxDurationMs;
    let cursor = checkpoint.rowId;
    let rows = 0;
    try {
      while (true) {
        await this.#assertGeneration(generation, { deadline, rows });
        const remaining = this.#limits.maxRows - rows;
        if (remaining <= 0) throw new RecoveryBoundaryError("row-limit", rows);
        const response = record(await this.#withinDeadline({ deadline, rows }, async () =>
          await this.#rpc.request("messages.after", {
            attachments: true,
            convert_attachments: false,
            include_reactions: true,
            limit: Math.min(500, remaining),
            since_rowid: cursor,
          }, this.#providerTimeout({ deadline, rows }))
        ));
        await this.#assertGeneration(generation, { deadline, rows });
        const messages = response.messages;
        const nextRowId = response.next_rowid;
        if (
          !Array.isArray(messages) ||
          typeof nextRowId !== "number" ||
          !Number.isSafeInteger(nextRowId) ||
          nextRowId < cursor ||
          typeof response.has_more !== "boolean"
        ) {
          throw new RecoveryBoundaryError("invalid-provider-page", rows);
        }
        if (rows + messages.length > this.#limits.maxRows) {
          throw new RecoveryBoundaryError("row-limit", rows);
        }
        for (const raw of messages) {
          await this.#assertGeneration(generation, { deadline, rows });
          const occurredAt = record(raw).created_at ?? record(raw).date;
          const occurredAtMs = typeof occurredAt === "string" ? Date.parse(occurredAt) : Number.NaN;
          if (!Number.isFinite(occurredAtMs)) {
            throw new RecoveryBoundaryError("invalid-provider-page", rows);
          }
          if (Date.now() - occurredAtMs > this.#limits.maxAgeMs) {
            throw new RecoveryBoundaryError("age-limit", rows);
          }
          const rawMessage = record(raw);
          await this.#deliver(
            rawMessage,
            generation,
            input,
            { deadline, rows },
            (error) => onDeferredDelivery(rawMessage, generation, error),
          );
          rows += 1;
        }
        await this.#assertGeneration(generation, { deadline, rows });
        await this.#withinDeadline(
          { deadline, rows },
          async () => await this.#state.advance(generation, nextRowId),
        );
        if (response.has_more !== true) return { rows, status: "recovered" };
        if (nextRowId <= cursor) throw new RecoveryBoundaryError("invalid-provider-page", rows);
        cursor = nextRowId;
      }
    } catch (error) {
      if (error instanceof RecoveryBoundaryError) {
        return {
          action: "live-events-only",
          reason: error.reason,
          rows: error.rows,
          status: "degraded",
        };
      }
      throw error;
    }
  }

  async #isSelfChatMirror(
    event: MessagesEvent,
    budget?: RecoveryBudget,
  ): Promise<boolean> {
    if (event.message.fromMe || event.message.text === null) return false;
    for (const outgoing of this.#recentOutgoing.values()) {
      if (isMirrorPair(event, outgoing)) return true;
    }
    const hasReplyLink =
      event.message.replyToProviderMessageId !== null &&
      event.message.replyToText === event.message.text;
    try {
      const request = async () => await this.#rpc.request("messages.after", {
          attachments: false,
          include_reactions: true,
          limit: 100,
          since_rowid: Math.max(0, event.message.rowId - 101),
        }, budget === undefined ? 30_000 : this.#providerTimeout(budget));
      const result = record(await (budget === undefined
        ? request()
        : this.#withinDeadline(budget, request)));
      for (const raw of Array.isArray(result.messages) ? result.messages : []) {
        const original = normalizeEvent(raw, event.conversationFacts);
        if (original === null) continue;
        if (
          hasReplyLink
            ? original.message.providerMessageId === event.message.replyToProviderMessageId &&
              isMirrorPair(event, original)
            : isMirrorPair(event, original)
        ) {
          return true;
        }
      }
      return false;
    } catch (error) {
      if (error instanceof RecoveryBoundaryError) throw error;
      return hasReplyLink;
    }
  }

  async #assertGeneration(generation: string, budget: RecoveryBudget): Promise<void> {
    let observed: string;
    try {
      observed = await this.#withinDeadline(
        budget,
        async () => await this.#refreshGeneration(),
      );
    } catch (error) {
      if (error instanceof RecoveryBoundaryError) throw error;
      throw new RecoveryBoundaryError("database-generation-unavailable", budget.rows);
    }
    if (observed !== generation) {
      throw new RecoveryBoundaryError("database-generation-changed", budget.rows);
    }
  }

  #remainingDuration(budget: RecoveryBudget): number {
    const remaining = budget.deadline - Date.now();
    if (remaining <= 0) throw new RecoveryBoundaryError("duration-limit", budget.rows);
    return Math.max(1, remaining);
  }

  #providerTimeout(budget: RecoveryBudget): number {
    return this.#remainingDuration(budget) + 1_000;
  }

  async #withinDeadline<T>(
    budget: RecoveryBudget,
    operation: () => Promise<T>,
  ): Promise<T> {
    const remaining = this.#remainingDuration(budget);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new RecoveryBoundaryError("duration-limit", budget.rows)),
            remaining,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #refreshGeneration(): Promise<string> {
    if (this.#databasePath === undefined) throw new Error("messages_database_generation_unavailable");
    return await databaseGeneration(this.#databasePath);
  }

  async #checkpointWitnessMatches(checkpoint: ProviderCheckpoint): Promise<boolean> {
    if (checkpoint.witnesses === undefined || checkpoint.witnesses.length === 0) return false;
    const highWatermark = record(await this.#rpc.request("messages.after", {
      attachments: false,
      include_reactions: true,
      limit: 1,
      since_rowid: Math.max(0, checkpoint.rowId - 1),
    }));
    if (!Array.isArray(highWatermark.messages)) {
      throw new Error("imsg returned invalid checkpoint evidence");
    }
    const tip = highWatermark.messages[0];
    if (tip === undefined) return false;
    const tipMessage = record(tip);
    if (typeof tipMessage.id !== "number" || !Number.isSafeInteger(tipMessage.id) ||
      tipMessage.id < checkpoint.rowId) {
      throw new Error("imsg returned invalid checkpoint evidence");
    }
    if (tipMessage.id === checkpoint.rowId) {
      const witness = checkpoint.witnesses.find((candidate) => candidate.rowId === checkpoint.rowId);
      return witness !== undefined && typeof tipMessage.guid === "string" &&
        this.#providerMessageDigest(tipMessage.guid) === witness.providerMessageDigest;
    }
    for (const witness of [...checkpoint.witnesses].reverse()) {
      const result = record(await this.#rpc.request("messages.after", {
        attachments: false,
        include_reactions: true,
        limit: 1,
        since_rowid: Math.max(0, witness.rowId - 1),
      }));
      if (!Array.isArray(result.messages)) {
        throw new Error("imsg returned invalid checkpoint evidence");
      }
      const matchingRow = result.messages.find((value) => record(value).id === witness.rowId);
      if (matchingRow === undefined) continue;
      const message = record(matchingRow);
      return typeof message.guid === "string" &&
        this.#providerMessageDigest(message.guid) === witness.providerMessageDigest;
    }
    return false;
  }

  #providerMessageDigest(providerMessageId: string): string {
    return createHash("sha256").update(providerMessageId).digest("base64url");
  }

  #rememberOutgoing(event: MessagesEvent): void {
    if (!event.message.fromMe) return;
    const key = `${event.conversation.chatId}:${event.message.providerMessageId}`;
    this.#recentOutgoing.delete(key);
    this.#recentOutgoing.set(key, event);
    while (this.#recentOutgoing.size > 64) {
      const oldest = this.#recentOutgoing.keys().next().value;
      if (oldest === undefined) return;
      this.#recentOutgoing.delete(oldest);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#rpc.close();
  }
}

export function createProntoMessages(input: CreateProntoMessagesOptions): ProntoMessages {
  return new ProntoMessagesClient(input);
}
