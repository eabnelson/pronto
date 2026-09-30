import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  releaseStagedAttachment,
  stageOutboundAttachment,
  stagedAttachmentExists,
  sweepStagedAttachments,
} from "../../packages/cli/src/core/outbound-attachment";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "pronto-outbound-"));
  temporaryDirectories.push(root);
  return { root, staging: join(root, "support", "outbound") };
}

test("copies an agent file into a private per-reply directory and deletes it on release", async () => {
  const { root, staging } = await workspace();
  const source = join(root, "chart.png");
  await writeFile(source, "png bytes");
  const staged = await stageOutboundAttachment({ maxBytes: 1_024, sourcePath: source, stagingDirectory: staging });

  expect(staged).not.toBeNull();
  expect(staged!.startsWith(`${staging}/reply-`)).toBeTrue();
  expect(staged!.endsWith("/chart.png")).toBeTrue();
  expect(await readFile(staged!, "utf8")).toBe("png bytes");
  expect((await stat(staging)).mode & 0o777).toBe(0o700);
  expect((await stat(dirname(staged!))).mode & 0o777).toBe(0o700);
  expect((await stat(staged!)).mode & 0o777).toBe(0o600);
  await writeFile(source, "changed later");
  expect(await readFile(staged!, "utf8")).toBe("png bytes");
  expect(await stagedAttachmentExists(staging, staged!)).toBeTrue();

  await releaseStagedAttachment(staging, staged!);
  expect(await readdir(staging)).toEqual([]);
  expect(await stagedAttachmentExists(staging, staged!)).toBeFalse();
  expect(await readFile(source, "utf8")).toBe("changed later");
});

test("refuses relative, missing, linked, special, empty, oversized, and unreadable files", async () => {
  const { root, staging } = await workspace();
  const stage = (sourcePath: string, maxBytes = 8) => {
    return stageOutboundAttachment({ maxBytes, sourcePath, stagingDirectory: staging });
  };
  const real = join(root, "real.txt");
  await writeFile(real, "12345");
  await symlink(real, join(root, "link.txt"));
  await writeFile(join(root, "empty.txt"), "");
  await writeFile(join(root, "large.txt"), "123456789");
  await writeFile(join(root, "secret.txt"), "hidden");
  await chmod(join(root, "secret.txt"), 0o000);
  await mkdir(join(root, "folder"));

  expect(await stage("real.txt")).toBeNull();
  expect(await stage(join(root, "missing.txt"))).toBeNull();
  expect(await stage(join(root, "link.txt"))).toBeNull();
  expect(await stage(join(root, "folder"))).toBeNull();
  expect(await stage(join(root, "empty.txt"))).toBeNull();
  expect(await stage(join(root, "large.txt"))).toBeNull();
  if (process.getuid?.() !== 0) expect(await stage(join(root, "secret.txt"))).toBeNull();
  expect(await readdir(staging).catch(() => [])).toEqual([]);
  expect(await stage(real)).not.toBeNull();
});

test("releases and reports only files inside the staging directory", async () => {
  const { root, staging } = await workspace();
  const outside = join(root, "keep", "file.txt");
  await mkdir(dirname(outside), { recursive: true });
  await writeFile(outside, "keep me");
  expect(await stagedAttachmentExists(staging, outside)).toBeFalse();
  await releaseStagedAttachment(staging, outside);
  await releaseStagedAttachment(staging, join(staging, "reply-x", "..", "..", "keep", "file.txt"));
  expect(await readFile(outside, "utf8")).toBe("keep me");
});

test("sweeps staged files that no pending send refers to", async () => {
  const { root, staging } = await workspace();
  const source = join(root, "report.pdf");
  await writeFile(source, "pdf");
  const pending = (await stageOutboundAttachment({ maxBytes: 64, sourcePath: source, stagingDirectory: staging }))!;
  const orphan = (await stageOutboundAttachment({ maxBytes: 64, sourcePath: source, stagingDirectory: staging }))!;
  await sweepStagedAttachments(staging, [pending, "/elsewhere/reply-1/file"]);
  expect(await stagedAttachmentExists(staging, pending)).toBeTrue();
  expect(await stagedAttachmentExists(staging, orphan)).toBeFalse();
  expect(await readdir(staging)).toEqual([dirname(pending).slice(staging.length + 1)]);
});
