/**
 * WhatsApp renders `*text*` as bold. Put the triggering tag on its own bold line, matching
 * the iMessage heading, so replies from different tags are easy to tell apart.
 */
export function formatWhatsappReplyText(activationTag: string, replyText: string): string {
  const heading = replyHeading(activationTag);
  return replyText === "" ? heading : `${heading}\n${replyText}`;
}

export function whatsappReplyBodyCharacterLimit(
  activationTag: string,
  totalCharacterLimit: number,
): number {
  return Math.max(0, totalCharacterLimit - replyHeading(activationTag).length - 1);
}

function replyHeading(activationTag: string): string {
  const displayName = activationTag.startsWith("@") ? activationTag.slice(1) : activationTag;
  const [first = "", ...rest] = [...displayName];
  return `*${first.toUpperCase()}${rest.join("")}*`;
}
