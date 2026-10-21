import { expect, test } from "bun:test";
import { removeOneMatchedTag } from "../../packages/cli/src/activation";
import { SlackChannel, slackActivation } from "../../packages/cli/src/slack/channel";
import type { SlackObservation } from "../../packages/slack/src/types";
const event: SlackObservation = { scope: { provider: "slack", version: 1, id: "synthetic-scope", token: "synthetic-seal", expiresAt: "2099-01-01T00:00:00.000Z" }, message: { conversation: "DSYNTHETIC", user: "USYNTHETIC", ts: "1792152000.000001", text: "@Pronto @pronto" }, fromMe: true, ownerParticipated: true, origin: "live", messageId: "slack:synthetic-source" };
test("Slack uses the shared literal tag matcher, including owner requests and conflicting tags", () => {
  expect(slackActivation(event, ["@pronto"])?.request).toBe("Help with this conversation.");
  expect(slackActivation(event, ["@pronto"])?.chat).toEqual({ channel: "slack", id: "synthetic-scope" });
  expect(slackActivation({ ...event, message: { ...event.message, text: "@pronto @other conflict" } }, ["@pronto", "@other"])).toBeNull();
});
test("Slack formatting keeps controls inert and the entire reply within 4,000 characters", () => {
  const channel = new SlackChannel({} as any);
  const formatted = channel.formatReply("@pronto", "<!channel> <@UFAKE> @here " + "&".repeat(5_000));
  expect(formatted).toStartWith("Pronto\n");
  expect(formatted).not.toContain("<!channel>");
  expect(formatted).not.toContain("@here");
  expect(formatted.length).toBeLessThanOrEqual(4_000);
  expect(formatted).not.toMatch(/&(a|am|amp)$/);
});

test("generated literal tags remain inert even if an ambiguous echo omits outbound identity", () => {
  const channel = new SlackChannel({} as any);
  const text = channel.formatReply("@pronto", "Quote @pronto and @other. Contact test@example.com.");
  expect(removeOneMatchedTag(text, ["@pronto", "@other"])).toBeNull();
  expect(text).toContain("test@example.com");
});
