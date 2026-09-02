import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig, saveConfig, UNRESTRICTED_TRUST_VERSION } from "../../packages/cli/src/config";
import { pathsForHome } from "../../packages/cli/src/macos/paths";
import { renderCompatibilityLauncher } from "../../packages/cli/src/compatibility";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Pronto CLI", () => {
  test("reports the package version from source", async () => {
    const process = Bun.spawn(["bun", "packages/cli/src/cli.ts", "--version"], {
      cwd: import.meta.dir.replace(/\/test\/unit$/, ""),
      stderr: "pipe",
      stdout: "pipe",
    });

    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("pronto 0.2.1");
  });

  test("the legacy command explains the rename and delegates safe commands", async () => {
    const process = Bun.spawn(["bun", "packages/cli/src/legacy-cli.ts", "--version"], {
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
    expect(stdout.trim()).toBe("pronto 0.2.1");
  });

  test("the legacy command refuses to start a second foreground listener", async () => {
    const process = Bun.spawn(["bun", "packages/cli/src/legacy-cli.ts", "run"], {
      cwd: import.meta.dir.replace(/\/test\/unit$/, ""),
      stderr: "pipe",
      stdout: "pipe",
    });

    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("cannot run run");
  });

  test("the legacy command refuses to install itself as Pronto", async () => {
    const process = Bun.spawn(["bun", "packages/cli/src/legacy-cli.ts", "setup"], {
      cwd: import.meta.dir.replace(/\/test\/unit$/, ""),
      stderr: "pipe",
      stdout: "pipe",
    });

    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("cannot run setup");
  });

  test("the installed compatibility launcher shares the safe-command policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pronto-compatibility-"));
    temporaryDirectories.push(directory);
    const pronto = join(directory, "pronto");
    const legacy = join(directory, "s4imsg");
    await writeFile(pronto, "#!/bin/sh\nprintf 'delegated:%s\\n' \"$1\"\n", { mode: 0o700 });
    await writeFile(legacy, renderCompatibilityLauncher(pronto), { mode: 0o700 });
    await chmod(legacy, 0o700);

    const unsafe = Bun.spawn([legacy, "setup"], { stderr: "pipe", stdout: "pipe" });
    expect(await unsafe.exited).toBe(2);
    expect(await new Response(unsafe.stderr).text()).toContain("cannot run setup");

    const safe = Bun.spawn([legacy, "status"], { stderr: "pipe", stdout: "pipe" });
    expect(await safe.exited).toBe(0);
    expect((await new Response(safe.stdout).text()).trim()).toBe("delegated:status");
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
    const process = Bun.spawn(["bun", "packages/cli/src/cli.ts", "tags"], {
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
