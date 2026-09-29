import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModule } from "../src/internal/module";
import { ReferenceSigner } from "../src/internal/reference";
import type { Tuning } from "../src/internal/tuning";
import type { CreateProntoWhatsappOptions, ProntoWhatsapp, WhatsappConversationReference } from "../src/index";
import type { FakeScenario } from "./fixtures/fake-wacli";

export const FAKE_WACLI = join(import.meta.dir, "fixtures", "fake-wacli.ts");
export const REFERENCE_KEY = "test-reference-key-with-at-least-32-chars";
export const OWNER = "15550001111@s.whatsapp.net";
export const ALICE = "15550002222@s.whatsapp.net";
export const BOB = "15550003333@s.whatsapp.net";
export const GROUP = "120363000000000001@g.us";

export const FAST_TUNING: Partial<Tuning> = {
  backoffInitialMs: 30,
  backoffMaxMs: 200,
  closeGraceMs: 500,
  commandTimeoutMs: 15_000,
  presenceTimeoutMs: 2_000,
  readinessPollMs: 20,
  readinessTimeoutMs: 10_000,
  sendTimeoutMs: 4_000,
};

const cleanups: (() => Promise<void>)[] = [];

export async function cleanupAll(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
}

export interface Harness {
  readonly dir: string;
  readonly module: ProntoWhatsapp;
  readonly statePath: string;
  readonly store: string;
  invocations(prefix?: string): Promise<{ args: string[]; command: string }[]>;
  reference(chatJid: string, ttlMs?: number): WhatsappConversationReference;
  webhookResults(): Promise<{ id: string; status: number }[]>;
  writeScenario(scenario: FakeScenario): Promise<void>;
  newModule(options?: Partial<CreateProntoWhatsappOptions>, tuning?: Partial<Tuning>): ProntoWhatsapp;
}

export async function setup(
  scenario: FakeScenario,
  options: Partial<CreateProntoWhatsappOptions> = {},
  tuning: Partial<Tuning> = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pronto-whatsapp-"));
  const store = join(dir, "store");
  const statePath = join(dir, "state", "whatsapp.json");
  const modules: ProntoWhatsapp[] = [];
  const newModule = (extra: Partial<CreateProntoWhatsappOptions> = {}, extraTuning: Partial<Tuning> = {}) => {
    const created = createModule({
      attachmentsDir: join(dir, "attachments"),
      referenceKey: REFERENCE_KEY,
      statePath,
      storeDir: store,
      wacliPath: FAKE_WACLI,
      ...options,
      ...extra,
    }, { ...FAST_TUNING, ...tuning, ...extraTuning });
    modules.push(created);
    return created;
  };
  const module = newModule();
  cleanups.push(async () => {
    await Promise.all(modules.map((created) => created.close()));
    await rm(dir, { force: true, recursive: true });
  });
  const harness: Harness = {
    dir,
    module,
    newModule,
    statePath,
    store,
    async invocations(prefix = "") {
      const text = await readFile(join(store, "invocations.ndjson"), "utf8").catch(() => "");
      return text.split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; command: string })
        .filter((entry) => entry.command.startsWith(prefix));
    },
    reference(chatJid, ttlMs = 60_000) {
      return new ReferenceSigner(REFERENCE_KEY, ttlMs, () => Date.now()).issue(chatJid);
    },
    async webhookResults() {
      const text = await readFile(join(store, "webhook-results.ndjson"), "utf8").catch(() => "");
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: string; status: number });
    },
    async writeScenario(next) {
      await writeFile(join(store, "scenario.json"), JSON.stringify(next));
    },
  };
  await mkdir(store, { mode: 0o700, recursive: true });
  await harness.writeScenario(scenario);
  return harness;
}

export async function waitFor<T>(
  probe: () => T | Promise<T>,
  { timeoutMs = 15_000, what = "condition" }: { timeoutMs?: number; what?: string } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

export function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

export function webhook(fields: {
  chat?: string;
  fromMe?: boolean;
  id: string;
  sender?: string;
  text?: string;
  ts?: string;
  [key: string]: unknown;
}): Record<string, unknown> {
  const { chat, fromMe, id, sender, text, ts, ...rest } = fields;
  return {
    Call: null,
    Chat: chat ?? ALICE,
    ChatName: "",
    Edited: false,
    FromMe: fromMe ?? false,
    ID: id,
    Media: null,
    Poll: null,
    PollVote: null,
    PushName: "Alice",
    ReactionEmoji: "",
    ReactionToID: "",
    ReplyToID: "",
    ReplyToSenderJID: "",
    Revoked: false,
    SenderJID: sender ?? (fromMe ? OWNER : chat ?? ALICE),
    Text: text ?? `text ${id}`,
    Timestamp: ts ?? iso(1_000),
    UnhandledPayload: "",
    ...rest,
  };
}

export function row(fields: {
  chat?: string;
  fromMe?: boolean;
  id: string;
  text?: string;
  ts: string;
  [key: string]: unknown;
}): Record<string, unknown> {
  const { chat, fromMe, id, text, ts, ...rest } = fields;
  return {
    ChatJID: chat ?? ALICE,
    ChatName: "Alice",
    DeletedForMe: false,
    DisplayText: text ?? `row ${id}`,
    Edited: false,
    FromMe: fromMe ?? false,
    MediaType: "",
    MsgID: id,
    ReactionEmoji: "",
    ReactionToID: "",
    Revoked: false,
    SenderJID: fromMe ? "" : chat ?? ALICE,
    SenderName: "Alice",
    Text: text ?? `row ${id}`,
    Timestamp: ts,
    ...rest,
  };
}

export const LINKED = { authenticated: true, linkedJid: OWNER } as const;
