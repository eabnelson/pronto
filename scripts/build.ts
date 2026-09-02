import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
await mkdir(dist, { recursive: true });
await rm(join(root, "packages", "messages", "dist"), { force: true, recursive: true });

const messagesBuild = Bun.spawn(
  [join(root, "node_modules", ".bin", "tsc"), "-p", join(root, "packages", "messages", "tsconfig.json")],
  { stderr: "inherit", stdout: "inherit" },
);
const messagesExitCode = await messagesBuild.exited;
if (messagesExitCode !== 0) process.exit(messagesExitCode);

for (const [source, output] of [
  ["packages/cli/src/cli.ts", "pronto"],
  ["packages/cli/src/legacy-cli.ts", "s4imsg"],
] as const) {
  const child = Bun.spawn(
    ["bun", "build", join(root, source), "--compile", "--outfile", join(dist, output)],
    { stderr: "inherit", stdout: "inherit" },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
