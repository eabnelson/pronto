import { expect, test } from "bun:test";
import { SLACK_GATES, validateSlackQualification, type SlackQualification } from "../../scripts/slack-qualification";
test("a release cannot claim Slack qualification from missing or prototype-only evidence", () => {
  const valid: SlackQualification = { version: 1, releaseTag: "v0.4.3", artifacts: { arm64: "a".repeat(64), x64: "b".repeat(64) }, checks: SLACK_GATES.map((id) => ({ id, status: "pass", evidence: "Synthetic qualification evidence fixture" })), monitoring: { durationMs: 1_800_000, conversations: 5, samples: 20, missed: 0, p95Ms: 9_000, clockSkewMs: 10 }, sleep: { durationMs: 7_200_000, nativeWake: true, independentlyPublishedDuringSleep: true } };
  expect(() => validateSlackQualification(valid, "v0.4.3")).not.toThrow();
  expect(() => validateSlackQualification({ ...valid, sleep: { ...valid.sleep!, independentlyPublishedDuringSleep: false } }, "v0.4.3")).toThrow();
  expect(() => validateSlackQualification({ ...valid, checks: valid.checks.slice(1) }, "v0.4.3")).toThrow();
  expect(() => validateSlackQualification(valid, "v0.4.4")).toThrow();
});
