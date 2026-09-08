/**
 * Content-only tag mechanics. No Messages access, eligibility or authorization.
 * Consumers validate their own allowed syntax, count and ownership of tags.
 */
export function normalizeTag(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith("@") ? trimmed : `@${trimmed}`).toLowerCase();
}

/** Normalize configuration, preserving first occurrence order. Empty input is valid here. */
export function normalizeTags(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeTag))];
}

/** Case-insensitive, bounded literal matches. Offsets use JavaScript UTF-16 indices. */
export function findTagRanges(text: string, tag: string): readonly [number, number][] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(
    `(^|[^\\p{L}\\p{N}\\p{M}._@-])(${escaped})(?=$|[^\\p{L}\\p{N}\\p{M}._@-])`,
    "giu",
  );
  return [...text.matchAll(expression)].map((match) => {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return [start, start + (match[2]?.length ?? tag.length)] as [number, number];
  });
}

export type TaggedMessageMatch =
  | { readonly status: "matched"; readonly tag: string; readonly message: string }
  | { readonly status: "ignored"; readonly reason: "missing" | "ambiguous" };

/**
 * Select exactly one configured candidate and remove all its occurrences.
 * Candidates must already be validated by the consumer. Duplicate candidates
 * remain ambiguous: two owners of one tag must never silently select an owner.
 * Distinct configured tags in one message are also ambiguous, even if a caller
 * intends them as aliases. Ignored results contain no message content.
 */
export function matchTaggedMessage(text: string, tags: readonly string[]): TaggedMessageMatch {
  let selected: { tag: string; ranges: readonly (readonly [number, number])[] } | undefined;
  for (const tag of tags) {
    const ranges = findTagRanges(text, tag);
    if (ranges.length === 0) continue;
    if (selected !== undefined) return { status: "ignored", reason: "ambiguous" };
    selected = { tag, ranges };
  }
  if (selected === undefined) return { status: "ignored", reason: "missing" };
  let message = text;
  for (const [start, end] of [...selected.ranges].reverse()) {
    message = `${message.slice(0, start)}${message.slice(end)}`;
  }
  message = message
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/gu, " ")
    .replace(/\s+([,:;.!?])/gu, "$1")
    .replace(/^[\s,:;.!?]+|[\s,:;.!?]+$/gu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return {
    status: "matched", tag: selected.tag,
    message: message === "" ? "Help with this conversation." : message,
  };
}
