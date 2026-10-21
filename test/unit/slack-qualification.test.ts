import { expect, test } from "bun:test";
import { validateSlackQualification, type SlackQualification } from "../../scripts/slack-qualification";

function record(): SlackQualification {
  return {
    version: 2,
    releaseTag: "v0.5.2",
    artifacts: { arm64: "a".repeat(64), x64: "b".repeat(64) },
    checks: ["signed-helper-arm64", "signed-helper-x64", "owner-acceptance", "setup-and-reply"]
      .map((id) => ({ id, status: "pass", evidence: "Recorded candidate evidence" })),
  };
}

test("the beta needs signed helpers and owner smoke evidence, without a timed test campaign", () => {
  expect(() => validateSlackQualification(record(), "v0.5.2")).not.toThrow();
});

test("pending, failed, stale or incomplete evidence still blocks publication", () => {
  const valid = record();
  const invalid: SlackQualification[] = [
    { ...valid, releaseTag: "v0.5.1" },
    { ...valid, artifacts: { arm64: "a".repeat(64) } },
    { ...valid, checks: valid.checks.slice(1) },
    { ...valid, checks: [...valid.checks, valid.checks[0]!] },
    ...(["pending", "fail"] as const).map((status) => ({
      ...valid, checks: [{ ...valid.checks[0]!, status }, ...valid.checks.slice(1)],
    })),
    { ...valid, checks: [{ ...valid.checks[0]!, evidence: "" }, ...valid.checks.slice(1)] },
    { ...valid, checks: [{ ...valid.checks[0]!, id: "unknown" }, ...valid.checks.slice(1)] },
  ];
  for (const value of invalid) expect(() => validateSlackQualification(value, "v0.5.2")).toThrow();
  expect(() => validateSlackQualification({ ...valid, version: 1 } as unknown as SlackQualification, "v0.5.2")).toThrow();
});
