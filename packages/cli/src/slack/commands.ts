import { homedir } from "node:os";
import { loadConfig, normalizeTags, saveConfig, createConfig, tagAssignments, SLACK_RISK_CONSENT_VERSION, UNRESTRICTED_TRUST_VERSION, type ProntoConfig, type SlackChannelConfig } from "../config";
import { isSlackChannel, type SlackChannelKind } from "../channels/types";
import { pathsForHome } from "../macos/paths";
import { reloadLaunchAgent } from "../macos/launch-agent";
import { discoverCommands, TRUST_DISCLOSURE } from "../macos/setup";
import { standaloneSlack, slackHelperPath, slackProviderDirectory, SLACK_DISCLOSURE } from "./standalone";

const usage = "pronto slack discover --json | link --workspace <handle> --events --accept-risk [--defer-tags | --tag <tag>...] | conversations list [--app slack:<workspace>] --json | conversations select (--conversation <handle>... | --clear) [--app <app>] --json | scope --all-participated [--app <app>] --json | unlink [--app <app>] --json";

function pruneAgents(config: ProntoConfig): ProntoConfig {
  if (config.tagRuntimes === undefined) return config;
  const tags = new Set(tagAssignments(config).map((entry) => entry.tag));
  return { ...config, tagRuntimes: Object.fromEntries(Object.entries(config.tagRuntimes).filter(([tag]) => tags.has(tag))) };
}

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
      if (["--json", "--events", "--accept-risk", "--accept-trust", "--clear", "--all-participated", "--defer-tags"].includes(flag)) flags.add(flag);
      else if (["--workspace", "--app", "--conversation", "--tag", "--runtime", "--working-directory"].includes(flag)) {
        const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(usage);
        values.set(flag, [...values.get(flag) ?? [], value]);
      } else throw new Error(usage);
    }
    if (!(["discover", "link", "unlink", "scope", "self-test"].includes(action ?? "") || action === "conversations" && ["list", "select"].includes(subaction ?? ""))) throw new Error(usage);
    if (flags.has("--defer-tags") && (action !== "link" || values.has("--tag"))) throw new Error(usage);
    if (action === "self-test") {
      await slackHelperPath(paths); emit({ helperProtocol: 1, version: "1", architecture: process.arch, signatureVerified: true }); return 0;
    }
    let config: ProntoConfig | null = null;
    try { config = await loadConfig(paths.configPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (config === null && action === "link") {
      if (!flags.has("--accept-trust")) throw new Error(`slack-setup-required: Run pronto setup and choose Slack, or supply --accept-trust --runtime <codex|claude> --working-directory <absolute folder>. ${TRUST_DISCLOSURE}`);
      const runtime = values.get("--runtime")?.[0]; const directory = values.get("--working-directory")?.[0];
      if ((runtime !== "codex" && runtime !== "claude") || !directory) throw new Error("slack-setup-required: Specify --runtime and --working-directory.");
      const runtimePath = discoverCommands().runtimes[runtime];
      if (!runtimePath) throw new Error("slack-runtime-missing");
      config = createConfig({ channels: { slack: { enabled: true, riskConsentVersion: SLACK_RISK_CONSENT_VERSION, tags: flags.has("--defer-tags") ? [] : values.get("--tag") ?? ["@pronto"] } }, primaryRuntime: runtime, primaryRuntimePath: runtimePath, workingDirectory: directory, unrestrictedTrustVersion: UNRESTRICTED_TRUST_VERSION });
    }
    if (config === null && action !== "discover") throw new Error("slack-setup-required: Run pronto setup and choose Slack.");
    const app = values.get("--app")?.[0] ?? "slack";
    if (!isSlackChannel(app) || (values.get("--app")?.length ?? 0) > 1) throw new Error("slack-workspace-invalid");
    provider = await standaloneSlack({ paths, chatKeySalt: config?.chatKeySalt ?? "onboarding-only-no-reply-authority-allowed", workspace: action === "link" || action === "discover" ? "slack" : app });
    if (action === "discover") {
      const discovery = await provider.discover();
      const legacy = await provider.connection();
      const added = new Set(Object.entries(config?.channels ?? {}).flatMap(([kind, entry]) => isSlackChannel(kind) && entry !== undefined ? [(entry as SlackChannelConfig).workspaceKey ?? (kind === "slack" ? legacy?.id : undefined)] : []));
      emit({ workspaceApps: true, deferredTags: true, workspaces: discovery.workspaces.map((row) => ({ ...row, connected: added.has(row.id) })) }); return 0;
    }
    if (action === "link") {
      if (!flags.has("--accept-risk")) throw new Error(`slack-consent-required: ${SLACK_DISCLOSURE}`);
      const workspace = values.get("--workspace"); if (workspace?.length !== 1) throw new Error(usage);
      const identity = await provider.workspace(workspace[0]!);
      const legacy = await provider.connection();
      const existing = Object.entries(config!.channels).find(([kind, entry]) => isSlackChannel(kind) && ((entry as SlackChannelConfig).workspaceKey === identity.id || kind === "slack" && legacy?.id === identity.id));
      const target: SlackChannelKind = existing ? existing[0] as SlackChannelKind
        : config!.channels.slack === undefined || !legacy && config!.channels.slack.workspaceKey === undefined ? "slack" : `slack:${identity.id}`;
      if (values.has("--app") && app !== target) throw new Error("slack-identity-mismatch");
      const previous = config!.channels[target];
      const explicitTags = values.has("--tag") ? normalizeTags(values.get("--tag")!) : undefined;
      if (events) emit({ event: "approval_required", message: "Approve Pronto in macOS if requested." });
      let linked: { workspace: string; member: string };
      if (target === "slack") {
        linked = await provider.link(workspace[0]!);
        await provider.useParticipatedConversations();
      } else {
        linked = await provider.linkWorkspace(workspace[0]!, slackProviderDirectory(paths, target));
      }
      // Credential approval can take time. Merge into the latest settings.
      const latest = await loadConfig(paths.configPath).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return config!; throw error; });
      const tags = explicitTags ?? latest.channels[target]?.tags ?? previous?.tags ?? (flags.has("--defer-tags") ? [] : ["@pronto"]);
      const next = createConfig(pruneAgents({ ...latest, channels: { ...latest.channels, [target]: { enabled: true, riskConsentVersion: SLACK_RISK_CONSENT_VERSION, tags, workspaceKey: identity.id, workspaceLabel: linked.workspace } } }));
      await saveConfig(paths.configPath, next);
      await reloadLaunchAgent().catch(() => undefined);
      emit({ ...linked, app: target, ...(events ? { event: "linked" } : {}), selectionRequired: false }); return 0;
    }
    if (config!.channels[app] === undefined) throw new Error("slack-workspace-not-added");
    if (action === "scope") {
      if (!flags.has("--all-participated")) throw new Error(usage);
      await provider.useParticipatedConversations();
      const identity = await provider.connection();
      if (identity) {
        const latest = await loadConfig(paths.configPath);
        const entry = latest.channels[app];
        if (!entry) throw new Error("slack-workspace-not-added");
        await saveConfig(paths.configPath, createConfig({ ...latest, channels: { ...latest.channels, [app]: { ...entry, workspaceKey: identity.id, workspaceLabel: identity.label } } }));
      }
      await reloadLaunchAgent().catch(() => undefined); emit({ app, coverage: "participated" }); return 0;
    }
    if (action === "unlink") {
      const channels = { ...config!.channels }; delete channels[app];
      const next = createConfig(pruneAgents({ ...config!, channels }));
      await provider.unlink(); await saveConfig(paths.configPath, next);
      await reloadLaunchAgent().catch(() => undefined); emit({ linked: false }); return 0;
    }
    if (subaction === "list") { emit(await provider.conversations()); return 0; }
    const handles = values.get("--conversation") ?? [];
    if (flags.has("--clear") ? handles.length !== 0 : handles.length === 0) throw new Error(usage);
    emit(await provider.select(handles)); await reloadLaunchAgent().catch(() => undefined); return 0;
  } catch (error) {
    const message = (error as Error).message;
    emit(events ? { event: "error", reason: message.split(":")[0], message } : { error: message }); return 1;
  } finally { await provider?.close(); }
}
