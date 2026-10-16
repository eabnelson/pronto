import { spawn } from "node:child_process";
import type { SlackBridge, SlackBridgeEvent, SlackOperation } from "./types.js";

/** Owner-private stdio only. Credentials never cross this boundary. */
function createProcessBridge(executable: string): SlackBridge {
  const child = spawn(executable, ["--rpc-v1"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...(process.env.HOME ? { HOME: process.env.HOME } : {}) } });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(event: SlackBridgeEvent) => void>();
  let buffer = Buffer.alloc(0); let next = 0; let closed = false;
  const fail = () => {
    if (closed) return; closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("slack-helper-terminated")); }
    pending.clear(); for (const listener of listeners) listener({ event: "health", state: "reconnecting", reason: "slack-helper-terminated" });
    child.kill("SIGKILL");
  };
  child.on("error", fail); child.on("exit", fail);
  // Never surface native stderr, which may include OS/provider details.
  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 4 * 1024 * 1024) { fail(); return; }
    let newline: number;
    while ((newline = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      try {
        const message = JSON.parse(line.toString("utf8"));
        if (message.version !== 1) throw new Error();
        if (message.event) {
          if (!["message", "wake", "health"].includes(message.event)) throw new Error();
          for (const listener of listeners) listener(message);
        } else {
          const request = pending.get(message.id); if (!request) continue;
          clearTimeout(request.timer); pending.delete(message.id);
          if (typeof message.error === "string") request.reject(new Error(/^slack-[a-z0-9-]{1,80}$/.test(message.error) ? message.error : "slack-helper-failed"));
          else request.resolve(message.result);
        }
      } catch { fail(); return; }
    }
  });
  return {
    request(operation: SlackOperation, input = {}) {
      if (closed) return Promise.reject(new Error("slack-helper-terminated"));
      const id = ++next; const data = JSON.stringify({ version: 1, id, operation, input });
      if (Buffer.byteLength(data) > 64 * 1024 || pending.size >= 32) return Promise.reject(new Error("slack-helper-budget"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("slack-helper-timeout")); fail(); }, operation === "connect" && input.interactive === true ? 60_000 : 30_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${data}\n`, (error) => { if (error) fail(); });
      });
    },
    listen(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    async close() { fail(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); },
  };
}

/** A crashed helper is replaced on the next operation; writes are never replayed. */
export function createSlackBridge(executable: string): SlackBridge {
  const listeners = new Set<(event: SlackBridgeEvent) => void>();
  let transport: SlackBridge | undefined; let dead = false; let closed = false;
  const current = () => {
    if (closed) throw new Error("slack-helper-closed");
    if (!transport || dead) {
      dead = false; transport = createProcessBridge(executable);
      transport.listen((event) => {
        if (event.event === "health" && event.reason === "slack-helper-terminated") dead = true;
        for (const listener of listeners) listener(event);
      });
    }
    return transport;
  };
  return { request: (operation, input) => current().request(operation, input), listen(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; }, async close() { closed = true; listeners.clear(); await transport?.close(); } };
}
