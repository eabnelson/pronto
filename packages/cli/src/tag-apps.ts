import { CHANNEL_LABELS, isChannelKind, type ChannelKind } from "./channels/types";

export interface TagAppChoice {
  readonly apps: ChannelKind[];
  readonly label: string;
}

export function appList(apps: readonly ChannelKind[]): string {
  return apps.map((app) => CHANNEL_LABELS[app]).join(" and ");
}

/** Choices offered when adding a tag: every enabled app first (the default), then each app alone. */
export function tagAppChoices(enabled: readonly ChannelKind[]): TagAppChoice[] {
  if (enabled.length <= 1) return [{ apps: [...enabled], label: appList(enabled) }];
  return [
    { apps: [...enabled], label: appList(enabled) },
    ...enabled.map((app) => ({ apps: [app], label: `${CHANNEL_LABELS[app]} only` })),
  ];
}

/** Accepts an empty answer (the default), a choice number, or an app name. */
export function parseTagAppChoice(answer: string, choices: readonly TagAppChoice[]): ChannelKind[] | null {
  const value = answer.trim().toLowerCase();
  if (value === "") return choices[0]?.apps ?? null;
  if (/^[1-9]$/.test(value)) return choices[Number(value) - 1]?.apps ?? null;
  const named = choices.find((choice) => choice.apps.length === 1 && choice.apps[0] === value);
  return named?.apps ?? null;
}

export function tagAppPrompt(tag: string, choices: readonly TagAppChoice[]): string {
  const options = choices.map((choice, index) => {
    return `  ${index + 1}. ${choice.label}${index === 0 ? " (default)" : ""}`;
  });
  return `Use ${tag} in which apps?\n${options.join("\n")}\nChoose [1]: `;
}

/** Parses repeated `--app <name>` flags; unknown names are an error. */
export function parseAppFlags(args: readonly string[]): {
  apps: ChannelKind[];
  json: boolean;
  positional: string[];
} {
  const apps: ChannelKind[] = [];
  const positional: string[] = [];
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") json = true;
    else if (arg === "--app") {
      const value = args[index + 1]?.toLowerCase();
      if (!isChannelKind(value)) throw new Error("--app must be imessage or whatsapp");
      if (!apps.includes(value)) apps.push(value);
      index += 1;
    } else positional.push(arg);
  }
  return { apps, json, positional };
}
