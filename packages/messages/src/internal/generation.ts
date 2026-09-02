import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";

export async function databaseGeneration(path: string): Promise<string> {
  const [resolved, metadata] = await Promise.all([realpath(path), stat(path)]);
  if (!metadata.isFile()) throw new Error("messages_database_generation_unavailable");
  return createHash("sha256").update(JSON.stringify({
    birthtimeMs: metadata.birthtimeMs,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    path: resolved,
  })).digest("base64url");
}
