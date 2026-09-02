import { expect, test } from "bun:test";
import { BoundedProcessRunner } from "../../packages/cli/src/runtimes/process";

test("bounds captured runtime output", async () => {
  const result = await new BoundedProcessRunner().run({
    args: ["-e", 'process.stdout.write("x".repeat(5000))'],
    env: {},
    executable: process.execPath,
    maxOutputBytes: 1_000,
    stdin: "",
    timeoutMs: 5_000,
    workingDirectory: process.cwd(),
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.length).toBeLessThanOrEqual(1_000);
  expect(result.outputLimitExceeded).toBeTrue();
});

test("escalates cancellation for a runtime that ignores termination", async () => {
  const result = await new BoundedProcessRunner().run({
    args: ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)'],
    env: {},
    executable: process.execPath,
    killGraceMs: 20,
    stdin: "",
    timeoutMs: 20,
    workingDirectory: process.cwd(),
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.timedOut).toBeTrue();
});
