import type { ChildProcess } from "node:child_process";
import type { WhatsappLinkStep } from "../types.js";
import { isRecord, spawnWacli } from "./process.js";

export interface LinkInput {
  /** Resolves the linked JID from `auth status`, or null when unlinked. */
  readonly linkedJid: () => Promise<string | null>;
  readonly closeGraceMs: number;
  readonly phone?: string;
  readonly signal?: AbortSignal;
  readonly storeDir: string;
  readonly wacliPath: string;
}

type Item =
  | { readonly kind: "line"; readonly line: string }
  | { readonly kind: "exit"; readonly code: number | null; readonly error: string | null };

const MAX_LINE_BYTES = 64 * 1024;
const BOOTSTRAP_LIMIT_MS = 10 * 60_000;

/** Drives `wacli auth` and reports QR codes, pairing codes, and the outcome. */
export async function* linkSteps(input: LinkInput): AsyncGenerator<WhatsappLinkStep> {
  if (input.signal?.aborted) return;
  const phone = input.phone?.replace(/[^0-9]/g, "") ?? "";
  if (input.phone !== undefined && phone === "") {
    yield { reason: "Phone number must contain digits", type: "failed" };
    return;
  }
  const args = ["--store", input.storeDir, "--events", "auth", "--qr-format", "text"];
  if (phone !== "") args.push(`--phone=${phone}`);

  const items: Item[] = [];
  let wake: (() => void) | null = null;
  const push = (item: Item) => {
    items.push(item);
    wake?.();
    wake = null;
  };
  let child: ChildProcess;
  try {
    child = spawnWacli(input.wacliPath, args);
  } catch (error) {
    yield { reason: error instanceof Error ? error.message : String(error), type: "failed" };
    return;
  }
  let spawned = false;
  child.once("spawn", () => {
    spawned = true;
  });
  child.once("error", (error) => {
    if (!spawned) push({ code: null, error: error.message, kind: "exit" });
  });
  child.once("close", (code) => {
    if (spawned) push({ code, error: null, kind: "exit" });
  });
  child.stdout?.resume();
  let pending = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      push({ kind: "line", line: pending.slice(0, newline) });
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (pending.length > MAX_LINE_BYTES) pending = "";
  });
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    wake?.();
    wake = null;
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  let linked = false;
  let lastError: string | null = null;
  try {
    for (;;) {
      if (aborted) return;
      const item = items.shift();
      if (item === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      if (item.kind === "exit") {
        if (linked) return;
        if (item.error !== null) {
          yield { reason: item.error, type: "failed" };
          return;
        }
        const jid = item.code === 0 ? await input.linkedJid().catch(() => null) : null;
        yield jid === null
          ? { reason: lastError ?? `wacli auth exited (${item.code ?? "signal"})`, type: "failed" }
          : { linkedJid: jid, type: "linked" };
        return;
      }
      const event = parseEvent(item.line);
      if (event === null) continue;
      const code = typeof event.data.code === "string" ? event.data.code : null;
      if (event.event === "qr_code" && code !== null && !linked) {
        yield { code, type: "qr" };
      } else if (event.event === "pair_code" && code !== null && !linked) {
        yield { code, type: "pairing_code" };
      } else if (event.event === "connected" && !linked) {
        const jid = await input.linkedJid().catch(() => null);
        if (jid !== null) {
          linked = true;
          yield { linkedJid: jid, type: "linked" };
        }
      } else if (event.event === "error" && typeof event.data.message === "string") {
        lastError = event.data.message;
      }
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    await stopChild(child, input.closeGraceMs, !linked || aborted);
  }
}

function parseEvent(line: string): { readonly data: Record<string, unknown>; readonly event: string } | null {
  try {
    const value: unknown = JSON.parse(line.trim());
    if (!isRecord(value) || typeof value.event !== "string") return null;
    return { data: isRecord(value.data) ? value.data : {}, event: value.event };
  } catch {
    return null;
  }
}

/** Stops the auth child. After a successful link it is allowed to finish its bootstrap sync. */
async function stopChild(child: ChildProcess, graceMs: number, interrupt: boolean): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let killTimer: NodeJS.Timeout | undefined;
  const interruptNow = () => {
    child.kill("SIGINT");
    killTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    killTimer.unref();
  };
  const bootstrapTimer = setTimeout(interruptNow, interrupt ? 0 : BOOTSTRAP_LIMIT_MS);
  bootstrapTimer.unref();
  await exited;
  clearTimeout(bootstrapTimer);
  if (killTimer !== undefined) clearTimeout(killTimer);
}
