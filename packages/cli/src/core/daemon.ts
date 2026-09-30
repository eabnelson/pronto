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

type Health = { reason?: string; state: ChannelHealth["state"] };

export class ProntoDaemon {
  #config: ProntoConfig;
  #stopRequested = false;
  #stop: (() => void) | null = null;
  #apply: ((config: ProntoConfig) => Promise<void>) | null = null;
  #reloads: Promise<void> = Promise.resolve();

  constructor(
    config: ProntoConfig,
    readonly paths: ProntoPaths,
  ) {
    this.#config = config;
  }

  get config(): ProntoConfig {
    return this.#config;
  }

  stop(): void {
    this.#stopRequested = true;
    this.#stop?.();
  }

  /**
   * Re-reads the configuration and applies tag changes and enabled apps without restarting.
   * Apps that need linking or failed to start are retried. Runtime, folder, and tool path
   * changes still need a listener restart, which setup performs.
   */
  reload(load: () => Promise<ProntoConfig>): Promise<void> {
    this.#reloads = this.#reloads.then(async () => {
      const next = await load();
      if (this.#apply === null) this.#config = next;
      else await this.#apply(next);
    }).catch((error: unknown) => {
      console.error(JSON.stringify({
        component: "daemon",
        reason: error instanceof Error ? error.message : "reload-failed",
        state: "reload-failed",
      }));
    });
    return this.#reloads;
  }

  async run(): Promise<void> {
    const database = openProntoDatabase(this.paths.databasePath, {
      schemaVersion: enabledChannels(this.#config).some((kind) => kind !== "imessage")
        ? MULTI_APP_SCHEMA_VERSION
        : DEFAULT_SCHEMA_VERSION,
    });
    const journal = new DeliveryJournal(database);
    journal.recordDaemonHealth("starting");
    // Live channels: qualified and routable. The turn processor and broker read this map.
    const channels = new Map<ChannelKind, Channel>();
    const created = new Map<ChannelKind, Channel>();
    const broker = new ConversationBroker(routeCurrentChat(channels));
    let brokerServer: ReturnType<ConversationBroker["listen"]> | null = null;
    const activeWatches = new Map<ChannelKind, ChannelWatch>();
    const health = new Map<ChannelKind, Health>();
    const degraded = new Map<ChannelKind, readonly string[]>();
    const recoveryReasons = new Map<ChannelKind, string>();
    let signalTransportClosed!: () => void;
    const transportClosed = new Promise<"transport-closed">((resolve) => {
      signalTransportClosed = () => resolve("transport-closed");
    });
    let coordinator: TurnCoordinator | undefined;

    const updateHealth = () => {
      if (this.#stopRequested) return;
      for (const [kind, current] of health) journal.recordChannelHealth(kind, current.state, current.reason);
      const states = [...health.values()].map((current) => current.state);
      journal.recordDaemonHealth(
        states.every((state) => state === "ready")
          ? "ready"
          : states.some((state) => state === "starting") ? "starting" : "degraded",
      );
      journal.recordDegradedCapabilities([
        ...[...degraded.values()].flat(),
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
    /** Creates and qualifies one app; returns the failure, if any. */
    const qualifyChannel = async (kind: ChannelKind): Promise<unknown> => {
      if (kind !== "imessage") journal.enableMultiApp();
      const channel = this.#createChannel(kind, journal);
      created.set(kind, channel);
      journal.recordChannelHealth(kind, "starting");
      try {
        const qualification = await channel.qualify();
        degraded.set(kind, qualification.degraded);
        health.set(kind, { state: "starting" });
        channels.set(kind, channel);
        return undefined;
      } catch (error) {
        // One app failing to qualify must not take the others down with it.
        const unavailable: Health = error instanceof ChannelNeedsLinkError
          ? { state: "needs_link" }
          : { reason: "qualification-failed", state: "failed" };
        health.set(kind, unavailable);
        journal.recordChannelHealth(kind, unavailable.state, unavailable.reason);
        return error;
      }
    };
    const watchChannel = async (kind: ChannelKind) => {
      const channel = channels.get(kind);
      if (channel === undefined || coordinator === undefined) return;
      const admit = coordinator;
      const watch = await channel.watch({
        onActivation: (activation) => {
          admit.admit(activation);
        },
        onHealth: (connection) => {
          if (connection.state === "needs_link") {
            health.set(kind, { state: "needs_link" });
          } else if (connection.state === "reconnecting") {
            health.set(kind, { reason: connection.reason, state: "degraded" });
          } else {
            health.set(kind, { state: "starting" });
            settle(kind);
          }
          updateHealth();
        },
        onRecovery: (outcome) => {
          if (outcome.status === "degraded") recoveryReasons.set(kind, outcome.reason);
          else recoveryReasons.delete(kind);
          settle(kind);
          updateHealth();
        },
        tags: () => channelTags(this.#config, kind),
      });
      activeWatches.set(kind, watch);
      void watch.terminated.then(() => {
        if (activeWatches.get(kind) === watch) signalTransportClosed();
      });
      settle(kind);
    };
    const stopChannel = async (kind: ChannelKind) => {
      const watch = activeWatches.get(kind);
      activeWatches.delete(kind);
      channels.delete(kind);
      await watch?.close().catch(() => undefined);
      await created.get(kind)?.close().catch(() => undefined);
      created.delete(kind);
      for (const state of [health, degraded, recoveryReasons]) state.delete(kind);
      journal.recordChannelHealth(kind, "stopped");
    };

    try {
      let firstFailure: unknown;
      for (const kind of enabledChannels(this.#config)) {
        firstFailure ??= await qualifyChannel(kind);
      }
      if (channels.size === 0) throw firstFailure ?? new Error("No messaging app is enabled");
      brokerServer = broker.listen();
      const primary = createRuntimeAdapter(this.#config.primaryRuntime, runtimePath(this.#config));
      const fallback =
        this.#config.fallbackRuntime === undefined
          ? undefined
          : createRuntimeAdapter(this.#config.fallbackRuntime, runtimePath(this.#config, true));
      const memory = new MemoryStore(database);
      const workspaces = new WorkspaceStore(database);
      coordinator = new TurnCoordinator(
        new TurnProcessor({
          bridgeExecutablePath: this.paths.executablePath,
          broker,
          brokerUrl: brokerServer.url,
          channels,
          journal,
          memory,
          runtimes: new RuntimeChain(primary, fallback),
          defaultWorkingDirectory: this.#config.workingDirectory,
          workspaces,
        }),
        journal,
        this.#config.chatKeySalt,
      );
      if (this.#stopRequested) coordinator.quiesce();
      const recovered = coordinator.start();
      const running = coordinator;
      updateHealth();

      const stopSignal = new Promise<"stop">((resolve) => {
        this.#stop = () => {
          running.quiesce();
          resolve("stop");
        };
        if (this.#stopRequested) this.#stop();
      });
      for (const kind of [...channels.keys()]) await watchChannel(kind);
      updateHealth();
      this.#apply = async (next) => {
        this.#config = next;
        const wanted = new Set(enabledChannels(next));
        for (const kind of [...created.keys()]) {
          if (!wanted.has(kind)) await stopChannel(kind);
        }
        for (const kind of wanted) {
          const state = health.get(kind)?.state;
          if (created.has(kind) && state !== "needs_link" && state !== "failed") continue;
          if (created.has(kind)) await stopChannel(kind);
          if (await qualifyChannel(kind) === undefined) await watchChannel(kind);
        }
        updateHealth();
      };
      if (!this.#stopRequested) {
        console.log(JSON.stringify({
          component: "daemon",
          degradedCapabilities: journal.degradedCapabilities(),
          recovery: recovered,
          state: journal.daemonHealth()?.state,
        }));
      }
      const outcome = await Promise.race([stopSignal, transportClosed]);
      this.#apply = null;
      await this.#reloads;
      if (outcome === "transport-closed") throw new Error("Pronto Messages transport closed");
      await closeWatches(activeWatches);
      await running.idle();
      journal.recordDaemonHealth("stopped");
      for (const kind of created.keys()) journal.recordChannelHealth(kind, "stopped");
    } catch (error) {
      journal.recordDaemonHealth("failed");
      for (const kind of created.keys()) journal.recordChannelHealth(kind, "failed");
      throw error;
    } finally {
      this.#stop = null;
      this.#apply = null;
      await closeWatches(activeWatches);
      brokerServer?.close();
      for (const channel of created.values()) await channel.close().catch(() => undefined);
      database.close();
    }
  }

  #createChannel(kind: ChannelKind, journal: DeliveryJournal): Channel {
    const matchesOutboundEcho = (chat: ChatAddress, text: string) => {
      return journal.matchesOutboundEcho(chat, text);
    };
    if (kind === "imessage") {
      const imessage = this.#config.channels.imessage;
      if (imessage === undefined) throw new Error("iMessage is not configured");
      const legacyUnscopedCursor = journal.cursor();
      return new ImessageChannel(
        createProntoMessages(standaloneMessagesOptions({
          chatKeySalt: this.#config.chatKeySalt,
          imsgPath: imessage.imsgPath,
          ...(legacyUnscopedCursor === undefined ? {} : { legacyUnscopedCursor }),
          providerStatePath: this.paths.providerStatePath,
        })),
        {
          matchesOutboundEcho,
          onMessageRowId: (rowId) => journal.advanceCursor(rowId),
        },
      );
    }
    const whatsapp = this.#config.channels.whatsapp;
    if (whatsapp === undefined) throw new Error("WhatsApp is not configured");
    return new WhatsappChannel(
      standaloneWhatsapp({
        chatKeySalt: this.#config.chatKeySalt,
        paths: this.paths,
        scopeTtlMs: STANDALONE_SCOPE_TTL_MS,
        wacliPath: whatsapp.wacliPath,
      }),
      { matchesOutboundEcho },
    );
  }
}

async function closeWatches(watches: Map<ChannelKind, ChannelWatch>): Promise<void> {
  for (const watch of watches.values()) await watch.close().catch(() => undefined);
  watches.clear();
}
