import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NdjsonRpcClient } from "../../src/imessage/rpc-client";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

test("exchanges NDJSON responses and notifications with a long-lived imsg process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-rpc-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "fake-imsg");
  await writeFile(
    executable,
    `#!/usr/bin/env bun
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocol_version: 1 } }));
    } else if (request.method === "watch.subscribe") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { subscription: 7 } }));
      console.log(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 7, message: { guid: "M1" } } }));
    }
  }
}
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const client = new NdjsonRpcClient(executable);
  const notifications: unknown[] = [];
  client.on("message", (params) => {
    notifications.push(params);
  });

  expect(await client.call("initialize", { protocol_version: 1 })).toEqual({
    protocol_version: 1,
  });
  expect(await client.call("watch.subscribe", {})).toEqual({ subscription: 7 });
  await Bun.sleep(10);
  expect(notifications).toEqual([{ message: { guid: "M1" }, subscription: 7 }]);
  await client.close();
});

test("keeps reading responses while a notification handler makes a nested call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-rpc-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "fake-imsg");
  await writeFile(
    executable,
    `#!/usr/bin/env bun
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "watch.subscribe") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { subscription: 7 } }));
      console.log(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 7 } }));
    } else if (request.method === "messages.stats") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sent_messages: 1 } }));
    }
  }
}
`,
    { mode: 0o700 },
  );
  const client = new NdjsonRpcClient(executable, { requestTimeoutMs: 250 });
  let nestedResult: unknown;
  let complete: (() => void) | undefined;
  const handled = new Promise<void>((resolve) => {
    complete = resolve;
  });
  client.on("message", async () => {
    nestedResult = await client.call("messages.stats", { chat_id: 42 });
    complete?.();
  });

  expect(await client.call("watch.subscribe")).toEqual({ subscription: 7 });
  await handled;
  expect(nestedResult).toEqual({ sent_messages: 1 });
  await client.close();
});

test("does not let sustained imsg diagnostics block RPC responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-rpc-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "fake-imsg");
  await writeFile(
    executable,
    `#!/usr/bin/env bun
import { fstatSync } from "node:fs";

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  while (buffer.includes("\\n")) {
    const newline = buffer.indexOf("\\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const stderr = fstatSync(2);
    await Bun.stderr.write(new Uint8Array(1024 * 1024).fill(120));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        ok: true,
        stderr_is_pipe: stderr.isFIFO() || stderr.isSocket(),
      },
    }));
  }
}
`,
    { mode: 0o700 },
  );
  const client = new NdjsonRpcClient(executable, { requestTimeoutMs: 250 });

  expect(await client.call("status")).toEqual({ ok: true, stderr_is_pipe: false });
  await client.close();
});

test("times out an unresponsive request and terminates a stuck child on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-rpc-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "fake-imsg");
  await writeFile(
    executable,
    `#!/usr/bin/env bun
for await (const _chunk of Bun.stdin.stream()) {}
await Bun.sleep(60_000);
`,
    { mode: 0o700 },
  );
  const client = new NdjsonRpcClient(executable, { closeTimeoutMs: 25, requestTimeoutMs: 25 });

  await expect(client.call("never.responds")).rejects.toThrow("timed out");
  await client.close();
});

test("fails closed and signals termination for malformed protocol output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-rpc-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "fake-imsg");
  await writeFile(
    executable,
    `#!/usr/bin/env bun
console.log("not-json");
await Bun.sleep(60_000);
`,
    { mode: 0o700 },
  );
  const client = new NdjsonRpcClient(executable, { closeTimeoutMs: 25 });

  await client.terminated;
  await expect(client.call("initialize")).rejects.toThrow("invalid JSON-RPC");
  await client.close();
});
