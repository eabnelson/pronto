import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
await mkdir(dist, { recursive: true });

for (const [source, output] of [
  ["src/cli.ts", "pronto"],
  ["src/legacy-cli.ts", "s4imsg"],
] as const) {
  const child = Bun.spawn(
    ["bun", "build", join(root, source), "--compile", "--outfile", join(dist, output)],
    { stderr: "inherit", stdout: "inherit" },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
