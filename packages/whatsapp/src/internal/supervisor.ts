import type { ChildProcess } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { WhatsappHealth } from "../types.js";
import { isRecord, spawnWacli } from "./process.js";
import type { Tuning } from "./tuning.js";

export const SEND_SOCKET = ".send.sock";
const MAX_LINE_BYTES = 64 * 1024;

export interface SupervisorHooks {
  readonly onHealth: (health: WhatsappHealth) => void;
  readonly onOfflineSyncCompleted: () => void;
  /** The session is gone (logged out or never linked); the supervisor has stopped for good. */
  readonly onTerminated: () => void;
}

export interface SupervisorOptions {
  readonly hooks: SupervisorHooks;
  readonly storeDir: string;
  readonly tuning: Tuning;
  readonly wacliPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly webhookSecret: string;
  readonly webhookUrl: string;
}

export type Readiness = "ready" | "stopped" | "timeout";

/** Runs `wacli sync --follow` and keeps it running until closed or unlinked. */
export class SyncSupervisor {
  #child: ChildProcess | null = null;
  #childExit: Promise<void> = Promise.resolve();
  #spawnedAt = 0;
  #connected = false;
  #connectedAt: number | null = null;
  #stopped = false;
  #terminal = false;
  #backoffMs: number;
  #restartTimer: NodeJS.Timeout | null = null;
  #lastError: string | null = null;
  #lastHealth: string | null = null;

  constructor(private readonly options: SupervisorOptions) {
    this.#backoffMs = options.tuning.backoffInitialMs;
  }

  get connected(): boolean {
    return this.#connected && !this.#stopped;
  }

  get terminated(): boolean {
    return this.#terminal;
  }

  start(): void {
    this.#health({ state: "starting" });
    void this.#spawn();
  }

  async waitReady(timeoutMs: number): Promise<Readiness> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.#stopped) return "stopped";
      if (this.#connected && await this.#delegateSocketFresh()) return "ready";
      if (Date.now() >= deadline) return "timeout";
      await delay(Math.min(this.options.tuning.readinessPollMs, Math.max(1, deadline - Date.now())));
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#connected = false;
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const child = this.#child;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), this.options.tuning.closeGraceMs);
      killTimer.unref();
      await this.#childExit;
      clearTimeout(killTimer);
    } else {
      await this.#childExit;
    }
  }

  async #spawn(): Promise<void> {
    if (this.#stopped) return;
    const { storeDir, wacliPath, webhookSecret, webhookUrl } = this.options;
    // wacli removes a stale socket too; removing it first keeps readiness checks unambiguous.
    await rm(join(storeDir, SEND_SOCKET), { force: true }).catch(() => undefined);
    if (this.#stopped) return;
    this.#spawnedAt = Date.now();
    this.#connected = false;
    this.#connectedAt = null;
    this.#lastError = null;
    const args = [
      "--store", storeDir,
      "--events",
      "sync", "--follow",
      "--presence-mode", "quiet",
      "--max-reconnect", "0",
      `--webhook=${webhookUrl}`,
      "--webhook-allow-private",
      `--webhook-secret=${webhookSecret}`,
      "--webhook-events", "message",
    ];
    let child: ChildProcess;
    try {
      child = spawnWacli(wacliPath, args, this.options.env);
    } catch (error) {
      this.#onExit(null, error instanceof Error ? error.message : String(error));
      return;
    }
    this.#child = child;
    let spawnError: string | null = null;
    let spawned = false;
    this.#childExit = new Promise<void>((resolve) => {
      child.once("spawn", () => {
        spawned = true;
      });
      child.once("error", (error) => {
        spawnError = error.message;
        if (!spawned) {
          this.#onExit(null, spawnError);
          resolve();
        }
      });
      child.once("close", (code, signal) => {
        if (spawned) this.#onExit(code ?? signal, spawnError);
        resolve();
      });
    });
    child.stdout?.resume();
    let pending = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        this.#onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_LINE_BYTES) pending = "";
    });
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      this.#lastError = trimmed.slice(0, 500);
      return;
    }
    if (!isRecord(value) || typeof value.event !== "string") return;
    const data = isRecord(value.data) ? value.data : {};
    switch (value.event) {
      case "connected":
        this.#connected = true;
        this.#connectedAt = Date.now();
        this.#health({ state: "connected" });
        break;
      case "reconnecting":
      case "disconnected":
      case "stream_replaced":
      case "stale":
        this.#connected = false;
        this.#health({ reason: value.event, state: "reconnecting" });
        break;
      case "offline_sync_completed":
        this.options.hooks.onOfflineSyncCompleted();
        break;
      case "logged_out":
        this.#terminate();
        break;
      case "error":
        if (typeof data.message === "string") {
          this.#lastError = data.message;
          if (/not authenticated/i.test(data.message)) this.#terminate();
        }
        break;
      default:
        break;
    }
  }

  #terminate(): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#stopped = true;
    this.#connected = false;
    this.#health({ state: "needs_link" });
    const child = this.#child;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), this.options.tuning.closeGraceMs);
      killTimer.unref();
      void this.#childExit.then(() => clearTimeout(killTimer));
    }
    this.options.hooks.onTerminated();
  }

  #onExit(status: number | string | null, spawnError: string | null): void {
    this.#child = null;
    this.#connected = false;
    if (this.#stopped) return;
    const { backoffInitialMs, backoffMaxMs, healthyResetMs } = this.options.tuning;
    if (this.#connectedAt !== null && Date.now() - this.#connectedAt >= healthyResetMs) {
      this.#backoffMs = backoffInitialMs;
    }
    const reason = spawnError ?? this.#lastError ?? `wacli sync exited (${status ?? "unknown"})`;
    this.#health(spawnError === null ? { reason, state: "reconnecting" } : { reason, state: "failed" });
    const wait = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, backoffMaxMs);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#spawn();
    }, wait);
  }

  async #delegateSocketFresh(): Promise<boolean> {
    try {
      const stats = await lstat(join(this.options.storeDir, SEND_SOCKET));
      return Math.max(stats.mtimeMs, stats.ctimeMs) >= this.#spawnedAt - 1_000;
    } catch {
      return false;
    }
  }

  #health(health: WhatsappHealth): void {
    const signature = JSON.stringify(health);
    if (signature === this.#lastHealth) return;
    this.#lastHealth = signature;
    this.options.hooks.onHealth(health);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
