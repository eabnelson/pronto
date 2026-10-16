import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, parse } from "node:path";
import { randomUUID } from "node:crypto";

export async function privateDirectory(directory: string): Promise<void> {
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, component);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(current);
    if (!stat.isDirectory() && !(process.platform === "darwin" && ["/tmp", "/var", "/etc"].includes(current) && stat.isSymbolicLink())) throw new Error("slack-unsafe-directory");
    if (current === absolute) {
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("slack-unsafe-owner");
      await chmod(current, 0o700);
    }
  }
}
export async function readPrivate<T>(file: string): Promise<T | null> {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (stat === null) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("slack-unsafe-state");
  return JSON.parse(await readFile(file, "utf8")) as T;
}
export async function writePrivate(file: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await open(dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
/** Serialize separate CLI/daemon mutations. A dead process cannot leave a permanent lock. */
export async function locked<T>(directory: string, action: () => Promise<T>): Promise<T> {
  await privateDirectory(directory);
  const file = join(directory, "mutation.lock");
  const deadline = Date.now() + 35_000;
  while (true) {
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(String(process.pid)); await handle.close(); break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("slack-unsafe-lock");
      const pid = Number(await readFile(file, "utf8"));
      let alive = true;
      try { if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0); else if (Date.now() - stat.mtimeMs > 5_000) alive = false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      if (!alive) { await rm(file, { force: true }); continue; }
      if (Date.now() >= deadline) throw new Error("slack-state-busy");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try { return await action(); } finally { await rm(file, { force: true }); }
}
