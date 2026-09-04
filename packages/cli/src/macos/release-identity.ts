export const PRONTO_SIGNING_IDENTIFIER = "dev.pronto.cli";
export const PRONTO_SIGNING_TEAM_IDENTIFIER = "9YCNUWK84C";

export type ReleaseIdentityRunner = (
  executable: string,
  args: readonly string[],
) => Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }>;

export async function inspectProntoExecutableIdentity(
  path: string,
  run: ReleaseIdentityRunner,
): Promise<{ readonly identifier: string; readonly teamIdentifier: string } | undefined> {
  const requirement = `identifier "${PRONTO_SIGNING_IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "${PRONTO_SIGNING_TEAM_IDENTIFIER}"`;
  const verified = await run("/usr/bin/codesign", ["--verify", "--strict", `-R=${requirement}`, path]);
  if (verified.exitCode !== 0) return undefined;
  const detail = await run("/usr/bin/codesign", ["-d", "--verbose=4", path]);
  if (detail.exitCode !== 0) return undefined;
  const identifier = /^Identifier=(.+)$/mu.exec(detail.stderr)?.[1]?.trim();
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(detail.stderr)?.[1]?.trim();
  if (identifier === undefined || teamIdentifier === undefined) return undefined;
  return { identifier, teamIdentifier };
}
