import { routeCurrentChat } from "../channels/current-chat";
import {
  ChannelNeedsLinkError,
  type Channel,
  type ChannelKind,
  type ChannelWatch,
  type ChatAddress,
} from "../channels/types";
import { channelTags, enabledChannels, type ProntoConfig } from "../config";
import { ImessageChannel } from "../imessage/channel";
import { WhatsappChannel } from "../whatsapp/channel";
import { standaloneWhatsapp } from "../whatsapp/standalone";
import type { ProntoPaths } from "../macos/paths";
import { RuntimeChain } from "../runtimes/chain";
import { createRuntimeAdapter } from "../runtimes/factory";
import { openProntoDatabase } from "../storage/database";
import { DeliveryJournal, type ChannelHealth } from "../storage/journal";
import { DEFAULT_SCHEMA_VERSION, MULTI_APP_SCHEMA_VERSION } from "../storage/migrations";
import { MemoryStore } from "../storage/memory";
import { WorkspaceStore } from "../storage/workspaces";
import { ConversationBroker } from "../tools/broker";
import { TurnCoordinator, TurnProcessor } from "./turn";
import {
  createProntoMessages,
  type CreateProntoMessagesOptions,
} from "pronto-imessage";

export const STANDALONE_SCOPE_TTL_MS = 24 * 60 * 60 * 1_000;

export function standaloneMessagesOptions(input: {
  readonly chatKeySalt: string;
  readonly imsgPath: string;
  readonly legacyUnscopedCursor?: number;
  readonly providerStatePath: string;
}): CreateProntoMessagesOptions {
  return {
    imsgPath: input.imsgPath,
    ...(input.legacyUnscopedCursor === undefined
      ? {}
      : { legacyUnscopedCursor: input.legacyUnscopedCursor }),
    referenceKey: input.chatKeySalt,
    scopeLimits: { ttlMs: STANDALONE_SCOPE_TTL_MS },
    statePath: input.providerStatePath,
  };
}

function runtimePath(config: ProntoConfig, fallback = false): string {
  const path = fallback ? config.fallbackRuntimePath : config.primaryRuntimePath;
  if (path === undefined) throw new Error("Runtime executable path is missing; run pronto setup");
  return path;
}

export class ProntoDaemon {
  #stopRequested = false;
  #stop: (() => void) | null = null;

  constructor(
    readonly config: ProntoConfig,
    readonly paths: ProntoPaths,
  ) {}

  stop(): void {
    this.#stopRequested = true;
    this.#stop?.();
  }

  async run(): Promise<void> {
    const kinds = enabledChannels(this.config);
    const database = openProntoDatabase(this.paths.databasePath, {
      schemaVersion: kinds.some((kind) => kind !== "imessage")
        ? MULTI_APP_SCHEMA_VERSION
        : DEFAULT_SCHEMA_VERSION,
    });
    const journal = new DeliveryJournal(database);
    journal.recordDaemonHealth("starting");
    const channels = this.#createChannels(journal);
    const broker = new ConversationBroker(routeCurrentChat(channels));
    let brokerServer: ReturnType<ConversationBroker["listen"]> | null = null;
    const activeWatches = new Map<ChannelKind, ChannelWatch>();
    const health = new Map<ChannelKind, { reason?: string; state: ChannelHealth["state"] }>();

    try {
      const degraded: string[] = [];
      let firstFailure: unknown;
      for (const channel of channels.values()) {
        journal.recordChannelHealth(channel.kind, "starting");
        try {
          const qualification = await channel.qualify();
          degraded.push(...qualification.degraded);
          health.set(channel.kind, { state: "starting" });
        } catch (error) {
          // One app failing to qualify must not take the others down with it.
          firstFailure ??= error;
          const unavailable = error instanceof ChannelNeedsLinkError
            ? { state: "needs_link" as const }
            : { reason: "qualification-failed", state: "failed" as const };
          health.set(channel.kind, unavailable);
          journal.recordChannelHealth(channel.kind, unavailable.state, unavailable.reason);
        }
      }
      const running = [...channels.values()].filter((channel) => {
        return health.get(channel.kind)?.state === "starting";
      });
      if (running.length === 0) throw firstFailure ?? new Error("No messaging app is enabled");
      brokerServer = broker.listen();
      const primary = createRuntimeAdapter(this.config.primaryRuntime, runtimePath(this.config));
      const fallback =
        this.config.fallbackRuntime === undefined
          ? undefined
          : createRuntimeAdapter(this.config.fallbackRuntime, runtimePath(this.config, true));
      const memory = new MemoryStore(database);
      const workspaces = new WorkspaceStore(database);
      const coordinator = new TurnCoordinator(
        new TurnProcessor({
          bridgeExecutablePath: this.paths.executablePath,
          broker,
          brokerUrl: brokerServer.url,
          channels: new Map(running.map((channel) => [channel.kind, channel])),
          journal,
          memory,
          runtimes: new RuntimeChain(primary, fallback),
          defaultWorkingDirectory: this.config.workingDirectory,
          workspaces,
        }),
        journal,
        this.config.chatKeySalt,
      );
      if (this.#stopRequested) coordinator.quiesce();
      const recovered = coordinator.start();
      journal.recordDegradedCapabilities(degraded);
      const recoveryReasons = new Map<ChannelKind, string>();
      const updateHealth = () => {
        if (this.#stopRequested) return;
        for (const kind of channels.keys()) {
          const current = health.get(kind);
          if (current === undefined) continue;
          journal.recordChannelHealth(kind, current.state, current.reason);
        }
        const states = [...health.values()].map((current) => current.state);
        journal.recordDaemonHealth(
          states.every((state) => state === "ready")
            ? "ready"
            : states.some((state) => state === "starting") ? "starting" : "degraded",
        );
        journal.recordDegradedCapabilities([
          ...degraded,
          ...[...recoveryReasons.values()].map((reason) => `messages-recovery-${reason}`),
          ...[...health].flatMap(([kind, current]) => {
            if (current.state === "needs_link") return [`${kind}-needs-link`];
            if (current.state === "failed") return [`${kind}-unavailable`];
            return [];
          }),
        ]);
      };
      const settle = (kind: ChannelKind) => {
        const reason = recoveryReasons.get(kind);
        const current = health.get(kind);
        if (current?.state === "needs_link" || current?.state === "failed") return;
        health.set(kind, reason !== undefined
          ? { reason, state: "degraded" }
          : { state: activeWatches.has(kind) ? "ready" : "starting" });
      };

      const stopSignal = new Promise<"stop">((resolve) => {
        this.#stop = () => {
          coordinator.quiesce();
          resolve("stop");
        };
        if (this.#stopRequested) this.#stop();
      });
      for (const channel of running) {
        activeWatches.set(channel.kind, await channel.watch({
          onActivation: (activation) => {
            coordinator.admit(activation);
          },
          onHealth: (connection) => {
            if (connection.state === "needs_link") {
              health.set(channel.kind, { state: "needs_link" });
            } else if (connection.state === "reconnecting") {
              health.set(channel.kind, { reason: connection.reason, state: "degraded" });
            } else {
              health.set(channel.kind, { state: "starting" });
              settle(channel.kind);
            }
            updateHealth();
          },
          onRecovery: (outcome) => {
            if (outcome.status === "degraded") recoveryReasons.set(channel.kind, outcome.reason);
            else recoveryReasons.delete(channel.kind);
            settle(channel.kind);
            updateHealth();
          },
          tags: channelTags(this.config, channel.kind),
        }));
        settle(channel.kind);
      }
      updateHealth();
      if (!this.#stopRequested) {
        console.log(JSON.stringify({
          component: "daemon",
          degradedCapabilities: journal.degradedCapabilities(),
          recovery: recovered,
          state: journal.daemonHealth()?.state,
        }));
      }
      const outcome = await Promise.race([
        stopSignal,
        ...[...activeWatches.values()].map((watch) => {
          return watch.terminated.then(() => "transport-closed" as const);
        }),
      ]);
      if (outcome === "transport-closed") throw new Error("Pronto Messages transport closed");
      await closeWatches(activeWatches);
      await coordinator.idle();
      journal.recordDaemonHealth("stopped");
      for (const kind of channels.keys()) journal.recordChannelHealth(kind, "stopped");
    } catch (error) {
      journal.recordDaemonHealth("failed");
      for (const kind of channels.keys()) journal.recordChannelHealth(kind, "failed");
      throw error;
    } finally {
      this.#stop = null;
      await closeWatches(activeWatches);
      brokerServer?.close();
      for (const channel of channels.values()) await channel.close().catch(() => undefined);
      database.close();
    }
  }

  #createChannels(journal: DeliveryJournal): Map<ChannelKind, Channel> {
    const channels = new Map<ChannelKind, Channel>();
    const matchesOutboundEcho = (chat: ChatAddress, text: string) => {
      return journal.matchesOutboundEcho(chat, text);
    };
    const imessage = this.config.channels.imessage;
    if (imessage?.enabled === true) {
      const legacyUnscopedCursor = journal.cursor();
      channels.set("imessage", new ImessageChannel(
        createProntoMessages(standaloneMessagesOptions({
          chatKeySalt: this.config.chatKeySalt,
          imsgPath: imessage.imsgPath,
          ...(legacyUnscopedCursor === undefined ? {} : { legacyUnscopedCursor }),
          providerStatePath: this.paths.providerStatePath,
        })),
        {
          matchesOutboundEcho,
          onMessageRowId: (rowId) => journal.advanceCursor(rowId),
        },
      ));
    }
    const whatsapp = this.config.channels.whatsapp;
    if (whatsapp?.enabled === true) {
      channels.set("whatsapp", new WhatsappChannel(
        standaloneWhatsapp({
          chatKeySalt: this.config.chatKeySalt,
          paths: this.paths,
          scopeTtlMs: STANDALONE_SCOPE_TTL_MS,
          wacliPath: whatsapp.wacliPath,
        }),
        { matchesOutboundEcho },
      ));
    }
    return channels;
  }
}

async function closeWatches(watches: Map<ChannelKind, ChannelWatch>): Promise<void> {
  for (const watch of watches.values()) await watch.close().catch(() => undefined);
  watches.clear();
}
