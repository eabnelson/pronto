/**
 * The Messages bridge sends plain text. Put the triggering tag on its own line
 * in the native Messages typeface so replies from different tags are easy to
 * distinguish without exposing Markdown punctuation.
 */
export function formatImessageReplyText(activationTag: string, replyText: string): string {
  const heading = replyHeading(activationTag);
  return replyText === "" ? heading : `${heading}\n${replyText}`;
}

export function imessageReplyBodyCharacterLimit(
  activationTag: string,
  totalCharacterLimit: number,
): number {
  return Math.max(0, totalCharacterLimit - replyHeading(activationTag).length - 1);
}

function replyHeading(activationTag: string): string {
  const displayName = activationTag.startsWith("@")
    ? activationTag.slice(1)
    : activationTag;
  return titleCase(displayName);
}

function titleCase(value: string): string {
  const [first = "", ...rest] = [...value];
  return `${first.toUpperCase()}${rest.join("")}`;
}
