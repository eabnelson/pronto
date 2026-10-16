import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSlackBridge } from "../../packages/slack/src/index";
test("private helper transport replaces a crashed process on the next read without replaying a write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-slack-rpc-"));
  const executable = join(directory, "fixture-helper");
  await writeFile(executable, `#!${process.execPath}\nimport { createInterface } from "node:readline";\nfor await (const line of createInterface({input:process.stdin})) { const request=JSON.parse(line); if(request.operation==="send") process.exit(1); console.log(JSON.stringify({version:1,id:request.id,result:{pid:process.pid}})); }\n`, { mode: 0o700 });
  const bridge = createSlackBridge(executable);
  try {
    const first = await bridge.request("connect");
    await expect(bridge.request("send")).rejects.toThrow("slack-helper-terminated");
    const next = await bridge.request("connect");
    expect(next.pid).not.toBe(first.pid);
  } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a foreign helper protocol fails closed without exposing its payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-slack-rpc-"));
  const executable = join(directory, "fixture-helper");
  await writeFile(executable, `#!${process.execPath}\nprocess.stdin.once("data",()=>console.log(JSON.stringify({version:99,id:1,result:{private:"synthetic-secret"}})));\n`, { mode: 0o700 });
  const bridge = createSlackBridge(executable);
  try { await expect(bridge.request("discover")).rejects.toThrow("slack-helper-terminated"); }
  finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});
