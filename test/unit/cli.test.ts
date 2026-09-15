import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig, saveConfig, UNRESTRICTED_TRUST_VERSION } from "../../packages/cli/src/config";
import { pathsForHome } from "../../packages/cli/src/macos/paths";
import { renderCompatibilityLauncher } from "../../packages/cli/src/compatibility";
import cliPackage from "../../packages/cli/package.json";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function linkedWorktree(base: string): Promise<string> {
  const commonDirectory = join(base, "repository", ".git");
  const gitDirectory = join(commonDirectory, "worktrees", "cli-fixture");
  const worktree = join(base, "conductor-worktree");
  await mkdir(gitDirectory, { recursive: true });
  await mkdir(worktree);
  await writeFile(join(gitDirectory, "HEAD"), "ref: refs/heads/cli-fixture\n");
  await writeFile(join(gitDirectory, "commondir"), "../..\n");
  await writeFile(join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
  await writeFile(join(gitDirectory, "gitdir"), `${join(worktree, ".git")}\n`);
  return await realpath(worktree);
}

describe("Pronto CLI", () => {
  test("exposes only the Pronto command to new package consumers", async () => {
    const packageJson = await Bun.file(
      new URL("../../packages/cli/package.json", import.meta.url),
    ).json() as { bin?: Record<string, string> };

    expect(packageJson.bin).toEqual({ pronto: "./src/cli.ts" });
  });

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
    expect(stdout.trim()).toBe(`pronto ${cliPackage.version}`);
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
    expect(stdout.trim()).toBe(`pronto ${cliPackage.version}`);
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

  test("the legacy migration launcher shares the safe-command policy", async () => {
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

  test("shows Conductor settings without exposing the stored API key", async () => {
    const home = await mkdtemp(join(tmpdir(), "pronto-cli-"));
    temporaryDirectories.push(home);
    await saveConfig(
      pathsForHome(home).configPath,
      createConfig({
        conductor: {
          agent: "codex",
          apiKey: "never-print-this-secret",
          model: "gpt-5.5",
          projectId: "project-1",
          tag: "@conductor",
        },
        imsgPath: "/usr/local/bin/imsg",
        primaryRuntime: "codex",
        tags: ["@helper"],
        unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
        workingDirectory: home,
      }),
    );
    const process = Bun.spawn(["bun", "packages/cli/src/cli.ts", "conductor", "status"], {
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
    expect(stdout).toContain("tag       @conductor");
    expect(stdout).toContain("project   project-1");
    expect(stdout).not.toContain("never-print-this-secret");
  });

  test("binds, lists, and unbinds a chat's selected local worktree agent", async () => {
    const home = await mkdtemp(join(tmpdir(), "pronto-cli-"));
    temporaryDirectories.push(home);
    const worktree = await linkedWorktree(home);
    const chatKey = `c_${"a".repeat(32)}`;
    await saveConfig(
      pathsForHome(home).configPath,
      createConfig({
        imsgPath: "/usr/local/bin/imsg",
        primaryRuntime: "codex",
        primaryRuntimePath: "/usr/local/bin/codex",
        tags: ["@helper"],
        unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
        workingDirectory: home,
      }),
    );
    const run = async (...args: string[]) => {
      const process = Bun.spawn(["bun", "packages/cli/src/cli.ts", ...args], {
        cwd: import.meta.dir.replace(/\/test\/unit$/, ""),
        env: { ...Bun.env, HOME: home },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stderr, stdout] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
        new Response(process.stdout).text(),
      ]);
      return { exitCode, stderr, stdout };
    };

    const bound = await run(
      "worktree",
      "bind",
      chatKey,
      worktree,
      "--agent",
      "codex",
    );
    expect(bound.exitCode).toBe(0);
    expect(bound.stdout).toContain(`Bound ${chatKey} to ${worktree} using codex.`);

    const listed = await run("worktree", "list");
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.trim()).toBe(`${chatKey}\tcodex\t${worktree}`);

    const unbound = await run("worktree", "unbind", chatKey);
    expect(unbound.exitCode).toBe(0);
    expect((await run("worktree", "list")).stdout.trim()).toBe("");
  });

  test("requires disabling Conductor instead of removing its reserved tag", async () => {
    const home = await mkdtemp(join(tmpdir(), "pronto-cli-"));
    temporaryDirectories.push(home);
    await saveConfig(
      pathsForHome(home).configPath,
      createConfig({
        conductor: {
          agent: "codex",
          apiKey: "owner-private-api-key",
          projectId: "project-1",
          tag: "@conductor",
        },
        imsgPath: "/usr/local/bin/imsg",
        primaryRuntime: "codex",
        tags: ["@helper"],
        unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION,
        workingDirectory: home,
      }),
    );
    const process = Bun.spawn(
      ["bun", "packages/cli/src/cli.ts", "tags", "remove", "@conductor"],
      {
        cwd: import.meta.dir.replace(/\/test\/unit$/, ""),
        env: { ...Bun.env, HOME: home },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("pronto conductor disable");
  });
});
