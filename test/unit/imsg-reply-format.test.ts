import { describe, expect, test } from "bun:test";
import { findTagRanges } from "../../packages/cli/src/activation";
import {
  formatImessageReplyText,
  imessageReplyBodyCharacterLimit,
} from "../../packages/cli/src/imessage/reply-format";

describe("iMessage reply formatting", () => {
  test("puts the triggering tag in title case on its own first line", () => {
    expect(formatImessageReplyText("@research", "I found the launch notes.")).toBe(
      "Research\nI found the launch notes.",
    );
  });

  test("preserves the rest of the tag spelling and punctuation", () => {
    expect(formatImessageReplyText("@studio_four-4", "Done.")).toBe(
      "Studio_four-4\nDone.",
    );
  });

  test("labels an empty response without creating a fresh activation", () => {
    const reply = formatImessageReplyText("@s4", "");
    expect(reply).toBe("S4");
    expect(findTagRanges(reply, "@s4")).toEqual([]);
  });

  test("reserves heading space inside the outbound character budget", () => {
    const limit = imessageReplyBodyCharacterLimit("@research", 4_000);
    expect(formatImessageReplyText("@research", "x".repeat(limit))).toHaveLength(4_000);
  });
});
