import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig, saveConfig, UNRESTRICTED_TRUST_VERSION } from "../../src/config";
import { pathsForHome } from "../../src/macos/paths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Pronto CLI", () => {
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
    expect(stdout.trim()).toBe("pronto 0.1.0");
  });

  test("the legacy command explains the rename and delegates safe commands", async () => {
    const process = Bun.spawn(["bun", "src/legacy-cli.ts", "--version"], {
      cwd: import.meta.dir.replace(/\/test\/unit$/, ""),
      stderr: "pipe",
      stdout: "pipe",
    });

    const [exitCode, stderr, stdout] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
      new Response(process.stdout).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr.trim()).toBe("s4imsg is now Pronto; use the pronto command.");
    expect(stdout.trim()).toBe("pronto 0.1.0");
  });

  test("lists every configured tag from the installed command surface", async () => {
    const home = await mkdtemp(join(tmpdir(), "pronto-cli-"));
    temporaryDirectories.push(home);
    await saveConfig(
      pathsForHome(home).configPath,
      createConfig({
        imsgPath: "/usr/local/bin/imsg",
        primaryRuntime: "codex",
        tags: ["@helper", "@plan", "@research"],
        unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
        workingDirectory: home,
      }),
    );
    const process = Bun.spawn(["bun", "src/cli.ts", "tags"], {
      cwd: import.meta.dir.replace(/\/test\/unit$/, ""),
      env: { ...Bun.env, HOME: home },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toEqual(["@helper", "@plan", "@research"]);
  });
});
