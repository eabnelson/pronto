import { describe, expect, test } from "bun:test";

describe("s4imsg CLI", () => {
  test("reports the package version from source", async () => {
    const process = Bun.spawn(["bun", "src/cli.ts", "--version"], {
      cwd: import.meta.dir.replace(/\/test\/unit$/, ""),
      stderr: "pipe",
      stdout: "pipe",
    });

    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("s4imsg 0.1.0");
  });
});
