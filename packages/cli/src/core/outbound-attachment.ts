import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { ensurePrivateDirectory } from "../config";

const COPY_CHUNK_BYTES = 64 * 1024;
const MAX_NAME_CHARACTERS = 120;

function stagedName(sourcePath: string): string {
  const name = basename(sourcePath).replace(/[\u0000-\u001f\u007f/\\:]/g, "_").slice(-MAX_NAME_CHARACTERS);
  return name === "" || name === "." || name === ".." ? "attachment" : name;
}

/**
 * Copies the one file an agent chose into a fresh private directory under the staging directory
 * (ADR 0004), so later changes to the original cannot alter what is sent. Returns the staged path,
 * or null when the source is not an absolute, readable, non-empty regular file (symbolic links are
 * refused) of at most `maxBytes`.
 */
export async function stageOutboundAttachment(input: {
  readonly maxBytes: number;
  readonly sourcePath: string;
  readonly stagingDirectory: string;
}): Promise<string | null> {
  if (!isAbsolute(input.sourcePath)) return null;
  const linkStat = await lstat(input.sourcePath).catch(() => null);
  if (linkStat === null || !linkStat.isFile() || linkStat.size === 0 || linkStat.size > input.maxBytes) {
    return null;
  }
  const source = await open(input.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (source === null) return null;
  let directory: string | undefined;
  try {
    const opened = await source.stat();
    if (!opened.isFile() || opened.ino !== linkStat.ino || opened.dev !== linkStat.dev) return null;
    await ensurePrivateDirectory(input.stagingDirectory);
    directory = await mkdtemp(join(input.stagingDirectory, "reply-"));
    const stagedPath = join(directory, stagedName(input.sourcePath));
    const target = await open(stagedPath, "wx", 0o600);
    let copied = 0;
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        copied += bytesRead;
        if (copied > input.maxBytes) break;
        await target.write(buffer, 0, bytesRead);
      }
    } finally {
      await target.close();
    }
    if (copied === 0 || copied > input.maxBytes) {
      await rm(directory, { force: true, recursive: true });
      return null;
    }
    return stagedPath;
  } catch {
    if (directory !== undefined) await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    return null;
  } finally {
    await source.close();
  }
}

/** The per-reply directory holding a staged file, or null when the path is not one Pronto staged. */
function stagedDirectory(stagingDirectory: string, stagedPath: string): string | null {
  const directory = dirname(stagedPath);
  const name = relative(stagingDirectory, directory);
  return isAbsolute(stagedPath) && name.startsWith("reply-") && !name.includes(sep) ? directory : null;
}

/** Whether a staged file is still present to send, e.g. when a send resumes after a restart. */
export async function stagedAttachmentExists(stagingDirectory: string, stagedPath: string): Promise<boolean> {
  if (stagedDirectory(stagingDirectory, stagedPath) === null) return false;
  const stat = await lstat(stagedPath).catch(() => null);
  return stat !== null && stat.isFile();
}

/** Deletes a staged file once its delivery outcome has settled. */
export async function releaseStagedAttachment(stagingDirectory: string, stagedPath: string): Promise<void> {
  const directory = stagedDirectory(stagingDirectory, stagedPath);
  if (directory !== null) await rm(directory, { force: true, recursive: true });
}

/** Deletes staged files left by an interrupted run, keeping those still waiting to be sent. */
export async function sweepStagedAttachments(
  stagingDirectory: string,
  keep: readonly string[],
): Promise<void> {
  const kept = new Set(keep.flatMap((path) => stagedDirectory(stagingDirectory, path) ?? []));
  await ensurePrivateDirectory(stagingDirectory);
  const entries = await readdir(stagingDirectory);
  for (const entry of entries) {
    const directory = join(stagingDirectory, entry);
    if (!kept.has(directory)) await rm(directory, { force: true, recursive: true });
  }
}
