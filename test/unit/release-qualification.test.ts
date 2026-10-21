import { expect, test } from "bun:test";
import { validateReleaseQualification } from "../../scripts/release-qualification";

function matrix(): string {
  return [
    "## Current matrix",
    "",
    "| Surface | Qualified version | Evidence | Status |",
    "| --- | --- | --- | --- |",
    ...["Installed startup", "Changed app flow", "Rollback readiness"].map(
      (surface) => `| ${surface} | v0.5.2 | Recorded candidate evidence | Pass |`,
    ),
  ].join("\n");
}

test("release smoke needs three practical results instead of a tool-version matrix", () => {
  expect(() => validateReleaseQualification(matrix(), "v0.5.2")).not.toThrow();
});

test("unproven or stale release evidence cannot pass", () => {
  const valid = matrix();
  for (const invalid of [
    valid.replace(/\| Pass \|/g, "| Pending |"),
    valid.replace(/\| Pass \|/g, "| Fail |"),
    valid.replace("v0.5.2", "v0.5.1"),
    valid.replace("Recorded candidate evidence", ""),
    valid.replace("| Rollback readiness | v0.5.2 | Recorded candidate evidence | Pass |", ""),
    `${valid}\n| Changed app flow | v0.5.2 | Recorded candidate evidence | Pass |`,
    valid.replace("Changed app flow", "Unknown result"),
    valid.replace("| Rollback readiness | v0.5.2 | Recorded candidate evidence | Pass |", "| Rollback readiness | Pass |"),
    `${valid}\n\n## Current matrix`,
  ]) expect(() => validateReleaseQualification(invalid, "v0.5.2")).toThrow();
  expect(() => validateReleaseQualification(valid, "not-a-tag")).toThrow();
});
