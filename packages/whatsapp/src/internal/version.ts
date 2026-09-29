/** Extracts `major.minor.patch` from `wacli version` output such as `0.19.0` or `v0.19.0-dev`. */
export function parseVersion(output: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
