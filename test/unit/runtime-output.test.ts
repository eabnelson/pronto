import { expect, test } from "bun:test";
import { RUNTIME_OUTPUT_SCHEMA, validateRuntimeOutput } from "../../packages/cli/src/runtimes/types";

test("uses a strict Codex-compatible schema while preserving optional output fields", () => {
  expect(RUNTIME_OUTPUT_SCHEMA.required).toEqual([
    "reply",
    "summary",
    "workspaceCandidates",
  ]);
  expect(validateRuntimeOutput({
    reply: "Done.",
    summary: null,
    workspaceCandidates: null,
  })).toEqual({ reply: "Done." });
  expect(validateRuntimeOutput({
    reply: "Done.",
    summary: "   ",
    workspaceCandidates: null,
  })).toEqual({ reply: "Done." });
});

test("accepts bounded workspace candidates in structured runtime output", () => {
  expect(
    validateRuntimeOutput({
      reply: "Choose one.",
      workspaceCandidates: ["/Users/example/one", "/Users/example/two"],
    }),
  ).toEqual({
    reply: "Choose one.",
    workspaceCandidates: ["/Users/example/one", "/Users/example/two"],
  });
});

test("rejects empty, oversized, or non-string workspace candidate sets", () => {
  expect(validateRuntimeOutput({ reply: "Choose.", workspaceCandidates: [] })).toBeNull();
  expect(
    validateRuntimeOutput({ reply: "Choose.", workspaceCandidates: Array(6).fill("/tmp") }),
  ).toBeNull();
  expect(validateRuntimeOutput({ reply: "Choose.", workspaceCandidates: [42] })).toBeNull();
});
