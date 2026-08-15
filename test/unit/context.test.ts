import { describe, expect, test } from "bun:test";
import { assembleContext } from "../../src/context/assemble";

describe("bounded context assembly", () => {
  test("combines transient recent messages with tagged memory", () => {
    const result = assembleContext({
      currentRequest: "What should we do next?",
      exactExchanges: [{ reply: "Use option A.", request: "Compare the options." }],
      recentMessages: [
        { isFromMe: false, senderLabel: "participant", text: "The deadline is Friday." },
      ],
      summary: "We are planning a release.",
    });

    expect(result.authorizedRequest).toBe("What should we do next?");
    expect(result.conversationContext).toContain("The deadline is Friday.");
    expect(result.conversationContext).toContain("Compare the options.");
    expect(result.conversationContext).toContain("We are planning a release.");
  });

  test("deterministically enforces component and total budgets", () => {
    const result = assembleContext({
      currentRequest: "current",
      exactExchanges: Array.from({ length: 20 }, (_, index) => ({
        reply: `reply-${index}-${"r".repeat(2_000)}`,
        request: `request-${index}-${"q".repeat(2_000)}`,
      })),
      recentMessages: Array.from({ length: 60 }, (_, index) => ({
        isFromMe: false,
        senderLabel: "participant",
        text: `recent-${index}-${"x".repeat(1_000)}`,
      })),
      summary: "s".repeat(8_000),
    });

    expect(result.conversationContext.length).toBeLessThanOrEqual(30_000);
    expect(result.includedRecentMessages).toBeLessThanOrEqual(30);
    expect(result.includedExactExchanges).toBeLessThanOrEqual(8);
    expect(result.summaryCharacters).toBeLessThanOrEqual(4_000);
    expect(result.conversationContext).toContain("recent-59");
    expect(result.conversationContext).not.toContain("recent-0-");
  });
});
