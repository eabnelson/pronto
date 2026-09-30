import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { signProntoExecutable } from "../packages/cli/src/macos/setup";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
await rm(dist, { force: true, recursive: true });
await mkdir(dist, { recursive: true });
for (const modulePackage of ["messages", "whatsapp"]) {
  await rm(join(root, "packages", modulePackage, "dist"), { force: true, recursive: true });
  const moduleBuild = Bun.spawn(
    [join(root, "node_modules", ".bin", "tsc"), "-p", join(root, "packages", modulePackage, "tsconfig.json")],
    { stderr: "inherit", stdout: "inherit" },
  );
  const moduleExitCode = await moduleBuild.exited;
  if (moduleExitCode !== 0) process.exit(moduleExitCode);
}

const prontoPath = join(dist, "pronto");
const prontoBuild = Bun.spawn(
  [
    "bun",
    "build",
    join(root, "packages", "cli", "src", "cli.ts"),
    "--compile",
    "--outfile",
    prontoPath,
  ],
  { stderr: "inherit", stdout: "inherit" },
);
const prontoBuildExitCode = await prontoBuild.exited;
if (prontoBuildExitCode !== 0) process.exit(prontoBuildExitCode);

if (process.platform === "darwin") {
  await signProntoExecutable(prontoPath);
}
