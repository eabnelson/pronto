import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_DELIVERED = 2_000;
const MAX_UNDELIVERED = 500;

/** A message seen but not delivered (stale on arrival, or the consumer callback failed). */
export interface UndeliveredMessage {
  readonly key: string;
  readonly occurredAtMs: number;
}

interface PersistedState {
  readonly delivered: readonly string[];
  readonly undelivered: readonly UndeliveredMessage[];
  readonly version: 1;
  readonly watermark: string | null;
}

/** Watermark plus a bounded recently-delivered set, persisted atomically at `statePath`. */
export class DeliveryState {
  #delivered = new Set<string>();
  #undelivered = new Map<string, number>();
  #watermarkMs: number | null = null;
  #loaded = false;

  constructor(private readonly path: string) {}

  get watermarkMs(): number | null {
    return this.#watermarkMs;
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#loaded = true;
      return;
    }
    const value = JSON.parse(text) as Partial<PersistedState>;
    if (value.version !== 1) throw new Error("pronto-whatsapp state has an unsupported version");
    const watermark = typeof value.watermark === "string" ? Date.parse(value.watermark) : NaN;
    this.#watermarkMs = Number.isFinite(watermark) ? watermark : null;
    this.#delivered = new Set(
      Array.isArray(value.delivered) ? value.delivered.filter((key) => typeof key === "string") : [],
    );
    this.#undelivered = new Map();
    for (const entry of Array.isArray(value.undelivered) ? value.undelivered : []) {
      if (typeof entry?.key === "string" && Number.isFinite(entry.occurredAtMs)) {
        this.#undelivered.set(entry.key, entry.occurredAtMs);
      }
    }
    this.#loaded = true;
  }

  has(key: string): boolean {
    return this.#delivered.has(key);
  }

  /** Oldest point a recovery sweep must cover: the watermark, or an older undelivered message. */
  sweepFloorMs(): number | null {
    let floor = this.#watermarkMs;
    for (const occurredAtMs of this.#undelivered.values()) {
      floor = floor === null ? occurredAtMs : Math.min(floor, occurredAtMs);
    }
    return floor;
  }

  async initializeWatermark(nowMs: number): Promise<void> {
    if (this.#watermarkMs !== null) return;
    this.#watermarkMs = nowMs;
    await this.#save();
  }

  async markDelivered(key: string, occurredAtMs: number | null): Promise<void> {
    this.#delivered.delete(key);
    this.#delivered.add(key);
    while (this.#delivered.size > MAX_DELIVERED) {
      const oldest = this.#delivered.values().next().value;
      if (oldest === undefined) break;
      this.#delivered.delete(oldest);
    }
    this.#undelivered.delete(key);
    if (occurredAtMs !== null) {
      this.#watermarkMs = Math.max(this.#watermarkMs ?? occurredAtMs, occurredAtMs);
    }
    await this.#save();
  }

  async markUndelivered(key: string, occurredAtMs: number): Promise<void> {
    if (this.#delivered.has(key)) return;
    this.#undelivered.set(key, occurredAtMs);
    while (this.#undelivered.size > MAX_UNDELIVERED) {
      const oldest = [...this.#undelivered.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest === undefined) break;
      this.#undelivered.delete(oldest[0]);
    }
    await this.#save();
  }

  async pruneUndelivered(olderThanMs: number): Promise<void> {
    let changed = false;
    for (const [key, occurredAtMs] of this.#undelivered) {
      if (occurredAtMs < olderThanMs) {
        this.#undelivered.delete(key);
        changed = true;
      }
    }
    if (changed) await this.#save();
  }

  #saveChain: Promise<void> = Promise.resolve();

  async #save(): Promise<void> {
    const next = this.#saveChain.catch(() => undefined).then(() => this.#write());
    this.#saveChain = next;
    await next;
  }

  async #write(): Promise<void> {
    const state: PersistedState = {
      delivered: [...this.#delivered],
      undelivered: [...this.#undelivered].map(([key, occurredAtMs]) => ({ key, occurredAtMs })),
      version: 1,
      watermark: this.#watermarkMs === null ? null : new Date(this.#watermarkMs).toISOString(),
    };
    const directory = dirname(this.path);
    await mkdir(directory, { mode: 0o700, recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
