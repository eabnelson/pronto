import { describe, expect, test } from "bun:test";
import { findTagRanges, matchTaggedMessage, normalizeTag, normalizeTags } from "../src/tags";

describe("public tag mechanics", () => {
  test("normalizes and deduplicates names without imposing consumer validation policy", () => {
    expect(normalizeTag(" Olle ")).toBe("@olle");
    expect(normalizeTags(["Olle", "@PRONTO", "@olle", "@Example.Team"])).toEqual([
      "@olle", "@pronto", "@example.team",
    ]);
    expect(normalizeTags([])).toEqual([]);
  });

  test.each(["@olle", "@pronto"])("accepts either configured name: %s", (tag) => {
    expect(matchTaggedMessage(`${tag} say hey`, ["@olle", "@pronto"])).toEqual({
      status: "matched", tag, message: "say hey",
    });
  });

  test("removes repeated occurrences, preserving configured spelling", () => {
    expect(matchTaggedMessage("(@OLLE) summarize @olle please!", ["@Olle"])).toEqual({
      status: "matched", tag: "@Olle", message: "summarize please",
    });
  });

  test("preserves the shared tag-only default", () => {
    expect(matchTaggedMessage("[@olle]", ["@olle"])).toEqual({
      status: "matched", tag: "@olle", message: "Help with this conversation.",
    });
  });

  test.each([
    "hello", "mail@olle.example", "word@olle", "café@olle", "e\u0301@olle",
    "@ollex", "@olle.more", "@olle_name", "@olle-name", "@@olle", "@olleé",
  ])("does not activate partial names or embedded mentions: %s", (text) => {
    expect(matchTaggedMessage(text, ["@olle"])).toEqual({ status: "ignored", reason: "missing" });
  });

  test("uses UTF-16 ranges correctly around emoji and punctuation", () => {
    expect(findTagRanges("👋 @OLLE, hi", "@olle")).toEqual([[3, 8]]);
    expect(matchTaggedMessage("👋 @OLLE, hi", ["@olle"])).toEqual({
      status: "matched", tag: "@olle", message: "👋, hi",
    });
  });

  test("matches punctuation in consumer-defined tags literally", () => {
    expect(matchTaggedMessage("@Example.Team_4-beta hi", ["@Example.Team_4-beta"])).toEqual({
      status: "matched", tag: "@Example.Team_4-beta", message: "hi",
    });
    expect(findTagRanges("@exampleXteam hi", "@example.team")).toEqual([]);
  });

  test("fails closed for two configured candidates, independent of order", () => {
    for (const tags of [["@olle", "@pronto"], ["@pronto", "@olle"], ["@olle", "@OLLE"]]) {
      expect(matchTaggedMessage("@olle @pronto hi", tags)).toEqual({
        status: "ignored", reason: "ambiguous",
      });
    }
  });

  test("does not remove unknown tags or disclose ignored text in the result", () => {
    expect(matchTaggedMessage("@olle ask @unknown", ["@olle"])).toEqual({
      status: "matched", tag: "@olle", message: "ask @unknown",
    });
    expect(matchTaggedMessage("private untagged content", [])).toEqual({
      status: "ignored", reason: "missing",
    });
  });
});
