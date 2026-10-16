import { homedir } from "node:os";
import { loadConfig, normalizeTags, saveConfig, createConfig, SLACK_RISK_CONSENT_VERSION, UNRESTRICTED_TRUST_VERSION, type ProntoConfig } from "../config";
import { pathsForHome } from "../macos/paths";
import { reloadLaunchAgent } from "../macos/launch-agent";
import { discoverCommands, TRUST_DISCLOSURE } from "../macos/setup";
import { standaloneSlack, slackHelperPath, SLACK_DISCLOSURE } from "./standalone";

const usage = "pronto slack discover --json | link --workspace <handle> --events --accept-risk [--tag <tag>]... | conversations list --json | conversations select (--conversation <handle>... | --clear) --json | unlink --json";
export async function runSlack(args: readonly string[]): Promise<number> {
  const paths = pathsForHome(homedir());
  const events = args.includes("--events");
  const emit = (value: unknown) => console.log(JSON.stringify(value));
  let provider: Awaited<ReturnType<typeof standaloneSlack>> | undefined;
  try {
    const [action, subaction] = args;
    const values = new Map<string, string[]>();
    const flags = new Set<string>();
    const start = action === "conversations" ? 2 : 1;
    for (let index = start; index < args.length; index++) {
      const flag = args[index]!;
      if (["--json", "--events", "--accept-risk", "--accept-trust", "--clear"].includes(flag)) flags.add(flag);
      else if (["--workspace", "--conversation", "--tag", "--runtime", "--working-directory"].includes(flag)) {
        const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(usage);
        values.set(flag, [...values.get(flag) ?? [], value]);
      } else throw new Error(usage);
    }
    if (!(["discover", "link", "unlink", "self-test"].includes(action ?? "") || action === "conversations" && ["list", "select"].includes(subaction ?? ""))) throw new Error(usage);
    if (action === "self-test") {
      await slackHelperPath(paths); emit({ helperProtocol: 1, version: "1", architecture: process.arch, signatureVerified: true }); return 0;
    }
    let config: ProntoConfig | null = null;
    try { config = await loadConfig(paths.configPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (config === null && action === "link") {
      if (!flags.has("--accept-trust")) throw new Error(`slack-setup-required: Run pronto setup and choose Slack, or supply --accept-trust --runtime <codex|claude> --working-directory <absolute folder>. ${TRUST_DISCLOSURE}`);
      const runtime = values.get("--runtime")?.[0]; const directory = values.get("--working-directory")?.[0];
      if ((runtime !== "codex" && runtime !== "claude") || !directory) throw new Error("slack-setup-required: Specify --runtime and --working-directory.");
      const discovered = discoverCommands(); const runtimePath = discovered.runtimes[runtime];
      if (!runtimePath) throw new Error("slack-runtime-missing");
      config = createConfig({ channels: { slack: { enabled: true, riskConsentVersion: SLACK_RISK_CONSENT_VERSION, tags: values.get("--tag") ?? ["@pronto"] } }, primaryRuntime: runtime, primaryRuntimePath: runtimePath, workingDirectory: directory, unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION });
    }
    if (config === null && action !== "discover") throw new Error("slack-setup-required: Run pronto setup and choose Slack.");
    provider = await standaloneSlack({ paths, chatKeySalt: config?.chatKeySalt ?? "onboarding-only-no-reply-authority-allowed" });
    if (action === "discover") { emit(await provider.discover()); return 0; }
    if (action === "link") {
      if (!flags.has("--accept-risk")) throw new Error(`slack-consent-required: ${SLACK_DISCLOSURE}`);
      const workspace = values.get("--workspace"); if (workspace?.length !== 1) throw new Error(usage);
      const tags = normalizeTags(values.get("--tag") ?? config!.channels.slack?.tags ?? ["@pronto"]);
      if (events) emit({ event: "approval_required", message: "Approve the Pronto Slack helper in macOS if requested." });
      const linked = await provider.link(workspace[0]!);
      await saveConfig(paths.configPath, createConfig({ ...config!, channels: { ...config!.channels, slack: { enabled: true, riskConsentVersion: SLACK_RISK_CONSENT_VERSION, tags } } }));
      await reloadLaunchAgent().catch(() => undefined);
      emit({ ...linked, ...(events ? { event: "linked" } : {}), selectionRequired: true }); return 0;
    }
    if (action === "unlink") { await provider.unlink(); await reloadLaunchAgent().catch(() => undefined); emit({ linked: false }); return 0; }
    if (subaction === "list") { emit(await provider.conversations()); return 0; }
    const handles = values.get("--conversation") ?? [];
    if (flags.has("--clear") ? handles.length !== 0 : handles.length === 0) throw new Error(usage);
    emit(await provider.select(handles)); await reloadLaunchAgent().catch(() => undefined); return 0;
  } catch (error) {
    const message = (error as Error).message;
    emit(events ? { event: "error", reason: message.split(":")[0], message } : { error: message }); return 1;
  } finally { await provider?.close(); }
}
