import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";

export async function databaseGeneration(path: string): Promise<string> {
  const identity = await databaseIdentity(path);
  return digest({
    birthtimeMs: identity.birthtimeMs,
    device: identity.device,
    inode: identity.inode,
    path: identity.path,
  });
}

/** Compatibility identity for checkpoints produced by the predecessor canonicalization. */
export async function legacyDatabaseGeneration(path: string): Promise<string> {
  const identity = await databaseIdentity(path);
  return digest({
    path: identity.path,
    device: identity.device,
    inode: identity.inode,
    birthtime: identity.birthtimeMs,
  });
}

async function databaseIdentity(path: string): Promise<{
  readonly birthtimeMs: number;
  readonly device: string;
  readonly inode: string;
  readonly path: string;
}> {
  const [resolved, metadata] = await Promise.all([realpath(path), stat(path)]);
  if (!metadata.isFile()) throw new Error("messages_database_generation_unavailable");
  return {
    birthtimeMs: metadata.birthtimeMs,
    device: String(metadata.dev),
    inode: String(metadata.ino),
    path: resolved,
  };
}

function digest(value: Readonly<Record<string, string | number>>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}
