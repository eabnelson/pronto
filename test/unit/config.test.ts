import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createConfig,
  loadConfig,
  normalizeTag,
  saveConfig,
} from "../../src/config";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("trigger tag validation", () => {
  test("normalizes a valid tag for case-insensitive matching", () => {
    expect(normalizeTag("@Helper_1")).toBe("@helper_1");
  });

  test("rejects unbounded or ambiguous tags", () => {
    for (const tag of ["helper", "@", "@two words", "@tool!", `@${"a".repeat(33)}`]) {
      expect(() => normalizeTag(tag)).toThrow("Tag must match");
    }
  });
});

describe("configuration persistence", () => {
  test("requires distinct primary and fallback runtimes", () => {
    expect(() =>
      createConfig({
        fallbackRuntime: "codex",
        imsgPath: "/opt/homebrew/bin/imsg",
        primaryRuntime: "codex",
        tag: "@helper",
        workingDirectory: "/Users/example",
      }),
    ).toThrow("Fallback runtime must differ");
  });

  test("round-trips owner-private configuration atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "s4imsg-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "config.json");
    const config = createConfig({
      fallbackRuntime: "claude",
      imsgPath: "/opt/homebrew/bin/imsg",
      primaryRuntime: "codex",
      tag: "@Helper",
      workingDirectory: "/Users/example",
    });

    await saveConfig(path, config);

    expect(await loadConfig(path)).toEqual(config);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
  });

  test("rejects a symlinked configuration directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "s4imsg-config-"));
    temporaryDirectories.push(directory);
    const actual = join(directory, "actual");
    await Bun.write(join(actual, ".keep"), "");
    await chmod(actual, 0o700);
    await Bun.$`ln -s ${actual} ${join(directory, "linked")}`.quiet();

    await expect(
      saveConfig(
        join(directory, "linked", "config.json"),
        createConfig({
          imsgPath: "/usr/local/bin/imsg",
          primaryRuntime: "claude",
          tag: "@helper",
          workingDirectory: "/Users/example",
        }),
      ),
    ).rejects.toThrow("symbolic link");
  });
});
