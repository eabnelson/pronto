import { expect, test } from "bun:test";
import { RUNTIME_OUTPUT_SCHEMA, validateRuntimeOutput } from "../../packages/cli/src/runtimes/types";

test("uses a strict Codex-compatible schema while preserving optional output fields", () => {
  expect(RUNTIME_OUTPUT_SCHEMA.required).toEqual([
    "attachmentPath",
    "reply",
    "summary",
    "workspaceCandidates",
  ]);
  expect(Object.keys(RUNTIME_OUTPUT_SCHEMA.properties).sort()).toEqual([...RUNTIME_OUTPUT_SCHEMA.required]);
  expect(validateRuntimeOutput({
    attachmentPath: null,
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

test("carries one attachment path and leaves file checks to delivery", () => {
  expect(validateRuntimeOutput({ attachmentPath: " /tmp/chart.png ", reply: "Here it is." }))
    .toEqual({ attachmentPath: "/tmp/chart.png", reply: "Here it is." });
  expect(validateRuntimeOutput({ attachmentPath: "relative.png", reply: "Here it is." }))
    .toEqual({ attachmentPath: "relative.png", reply: "Here it is." });
  expect(validateRuntimeOutput({ attachmentPath: "  ", reply: "Done." })).toEqual({ reply: "Done." });
  expect(validateRuntimeOutput({ attachmentPath: ["/tmp/a", "/tmp/b"], reply: "Two." })).toBeNull();
  expect(validateRuntimeOutput({ attachmentPath: `/${"a".repeat(4_096)}`, reply: "Long." })).toBeNull();
});
