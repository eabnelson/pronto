import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openProntoDatabase } from "../../packages/cli/src/storage/database";
import {
  canonicalLinkedWorktree,
  WorktreeBindingStore,
} from "../../packages/cli/src/storage/worktree-bindings";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function linkedWorktree(base: string): Promise<string> {
  const commonDirectory = join(base, "repository", ".git");
  const gitDirectory = join(commonDirectory, "worktrees", "fixture");
  const worktree = join(base, "workspace");
  await mkdir(gitDirectory, { recursive: true });
  await mkdir(worktree);
  await writeFile(join(gitDirectory, "HEAD"), "ref: refs/heads/fixture\n");
  await writeFile(join(gitDirectory, "commondir"), "../..\n");
  await writeFile(join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
  await writeFile(join(gitDirectory, "gitdir"), `${join(worktree, ".git")}\n`);
  return await realpath(worktree);
}

test("accepts only an available linked Git worktree root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-worktree-"));
  temporaryDirectories.push(directory);
  const worktree = await linkedWorktree(directory);
  expect(await canonicalLinkedWorktree(worktree)).toBe(worktree);

  const ordinaryRepository = join(directory, "ordinary");
  await mkdir(join(ordinaryRepository, ".git"), { recursive: true });
  await expect(canonicalLinkedWorktree(ordinaryRepository)).rejects.toThrow(
    "Invalid linked Git worktree marker",
  );

  await writeFile(join(directory, "repository", ".git", "worktrees", "fixture", "gitdir"),
    `${join(directory, "somewhere-else", ".git")}\n`);
  await expect(canonicalLinkedWorktree(worktree)).rejects.toThrow();
});

test("persists, replaces, lists, and removes one binding per chat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-worktree-"));
  temporaryDirectories.push(directory);
  const database = openProntoDatabase(join(directory, "state.sqlite"));
  const store = new WorktreeBindingStore(database, () => 42);
  try {
    expect(store.bind({
      agent: "codex",
      chatKey: "chat-a",
      worktreePath: "/worktree/one",
    })).toEqual({
      agent: "codex",
      chatKey: "chat-a",
      worktreePath: "/worktree/one",
    });
    store.bind({
      agent: "claude",
      chatKey: "chat-a",
      worktreePath: "/worktree/two",
    });
    expect(store.list()).toEqual([{
      agent: "claude",
      chatKey: "chat-a",
      worktreePath: "/worktree/two",
    }]);
    expect(store.delete("chat-a")).toBeTrue();
    expect(store.delete("chat-a")).toBeFalse();
    expect(store.get("chat-a")).toBeNull();
  } finally {
    database.close();
  }
});
