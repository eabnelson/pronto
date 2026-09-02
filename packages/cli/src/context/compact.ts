export const MAX_SUMMARY_CHARACTERS = 4_000;

export function validSummary(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const summary = value.trim();
  if (summary.length === 0 || summary.length > MAX_SUMMARY_CHARACTERS) return null;
  return summary;
}
