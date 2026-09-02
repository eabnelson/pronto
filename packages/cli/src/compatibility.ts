const RENAME_NOTICE = "s4imsg is now Pronto; use the pronto command.";
const UNSAFE_COMMANDS = ["run", "setup"] as const;

export function compatibilityNotice(): string {
  return RENAME_NOTICE;
}

export function compatibilityRejection(command: string | undefined): string | null {
  return command !== undefined && UNSAFE_COMMANDS.some((unsafe) => unsafe === command)
    ? `The s4imsg compatibility command cannot run ${command}; use pronto ${command}.`
    : null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderCompatibilityLauncher(prontoExecutable: string): string {
  return `#!/bin/sh
printf '%s\\n' ${shellQuote(RENAME_NOTICE)} >&2
case "\${1-}" in
  ${UNSAFE_COMMANDS.join("|")})
    printf '%s\\n' "The s4imsg compatibility command cannot run \${1}; use pronto \${1}." >&2
    exit 2
    ;;
esac
exec ${shellQuote(prontoExecutable)} "$@"
`;
}
