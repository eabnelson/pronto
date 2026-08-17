import { expect, test } from "bun:test";
import { validateRuntimeOutput } from "../../src/runtimes/types";

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
