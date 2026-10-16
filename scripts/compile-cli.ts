import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const [output = join(root, "dist/pronto"), target = `bun-darwin-${process.arch}`] = process.argv.slice(2);
if (process.platform !== "darwin" || !["bun-darwin-arm64", "bun-darwin-x64"].includes(target)) {
  throw new Error("Slack native builds require macOS and a supported target");
}
const architecture = target.endsWith("arm64") ? "arm64" : "amd64";
const clangArchitecture = architecture === "amd64" ? "x86_64" : architecture;
const nativeOutput = join(root, "packages/slack/native/dist", architecture, "slack-helper");
await mkdir(dirname(nativeOutput), { recursive: true });
const nativeBuild = Bun.spawn(["go", "build", "-trimpath", "-o", nativeOutput, "."], {
  cwd: join(root, "packages/slack/native"),
  env: {
    ...process.env,
    GOARCH: architecture,
    CGO_ENABLED: "1",
    MACOSX_DEPLOYMENT_TARGET: "14.0",
    CGO_CFLAGS: `-arch ${clangArchitecture} -mmacosx-version-min=14.0`,
    CGO_LDFLAGS: `-arch ${clangArchitecture} -mmacosx-version-min=14.0`,
  },
  stdout: "inherit",
  stderr: "inherit",
});
if (await nativeBuild.exited !== 0) throw new Error("Slack helper compilation failed");

const identity = process.argv[4]?.trim() || process.env.PRONTO_CODESIGN_IDENTITY?.trim() || "-";
const sign = Bun.spawn([
  "/usr/bin/codesign", "--force", "--identifier", "dev.pronto.slack-helper",
  ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
  "--sign", identity, nativeOutput,
], { stdout: "inherit", stderr: "inherit" });
if (await sign.exited !== 0) throw new Error("Slack helper signing failed");

if (identity !== "-" && process.env.PRONTO_NOTARY_KEY_PATH &&
    process.env.PRONTO_NOTARY_KEY_ID && process.env.PRONTO_NOTARY_ISSUER_ID) {
  const archive = `${nativeOutput}.zip`;
  const zip = Bun.spawn(["/usr/bin/ditto", "-c", "-k", "--keepParent", nativeOutput, archive], {
    stdout: "inherit", stderr: "inherit",
  });
  if (await zip.exited !== 0) throw new Error("Slack helper archive failed");
  const notary = Bun.spawn([
    "/usr/bin/xcrun", "notarytool", "submit", archive,
    "--issuer", process.env.PRONTO_NOTARY_ISSUER_ID,
    "--key-id", process.env.PRONTO_NOTARY_KEY_ID,
    "--key", process.env.PRONTO_NOTARY_KEY_PATH,
    "--wait", "--output-format", "json",
  ], { stdout: "pipe", stderr: "pipe" });
  // Drain both pipes; errors stay local rather than becoming product diagnostics.
  const [report, , code] = await Promise.all([
    new Response(notary.stdout).text(), new Response(notary.stderr).text(), notary.exited,
  ]);
  if (code !== 0 || JSON.parse(report).status !== "Accepted") {
    throw new Error("Slack helper notarization failed");
  }
}

const bytes = await readFile(nativeOutput);
await mkdir(dirname(resolve(output)), { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "packages/cli/src/cli.ts")],
  compile: { target: target as "bun-darwin-arm64" | "bun-darwin-x64", outfile: resolve(output) },
  define: {
    PRONTO_SLACK_HELPER_BASE64: JSON.stringify(bytes.toString("base64")),
    PRONTO_SLACK_HELPER_SHA256: JSON.stringify(createHash("sha256").update(bytes).digest("hex")),
    PRONTO_SLACK_HELPER_RELEASE: JSON.stringify(identity !== "-"),
  },
});
if (!result.success) throw new AggregateError(result.logs, "CLI compilation failed");
