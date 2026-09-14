import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";

export async function databaseGeneration(path: string): Promise<string> {
  return (await databaseGenerations(path)).current;
}

/** Both identities come from one filesystem observation. The old reader uses rollback. */
export async function databaseGenerations(path: string): Promise<{ current: string; rollback: string }> {
  const identity = await databaseIdentity(path);
  return {
    current: `v2:${digest({
      // Millisecond precision is shared by supported runtimes. Device
      // numbers identify a mount instance, not a durable database across reboot.
      birthtimeMs: Math.floor(identity.birthtimeMs),
      inode: identity.inode,
      path: identity.path,
    })}`,
    rollback: digest({
      birthtimeMs: identity.birthtimeMs,
      device: identity.device,
      inode: identity.inode,
      path: identity.path,
    }),
  };
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

/** Prove the old digest's non-mount fields; witnesses are additionally required by the caller. */
export async function compatibleOldDatabaseGeneration(path: string, generation: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(generation)) return false;
  const identity = await databaseIdentity(path);
  const currentDevice = Number(identity.device);
  // Bounded compatibility for nearby macOS mount allocations. No witness-only
  // fallback: an unprovable old fingerprint still requires explicit recovery.
  for (let delta = -64; delta <= 64; delta++) {
    const device = String(currentDevice + delta);
    if (digest({ birthtimeMs: identity.birthtimeMs, device, inode: identity.inode, path: identity.path }) === generation ||
        digest({ path: identity.path, device, inode: identity.inode, birthtime: identity.birthtimeMs }) === generation) return true;
  }
  return false;
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
