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
  const directory = await mkdtemp(join(tmpdir(), "s4imsg-rpc-"));
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
