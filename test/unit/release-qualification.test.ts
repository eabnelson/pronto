import { describe, expect, test } from "bun:test";
import { validateReleaseQualification } from "../../scripts/release-qualification";

const surfaces = [
  "macOS",
  "Bun",
  "imsg",
  "Codex CLI",
  "Claude Code",
  "Codex effective local probe",
  "Claude effective local probe",
  "Messages Automation",
  "Self-chat mirror handling",
  "Full remote tagged flow",
] as const;

function matrix(
  overrides: Partial<Record<(typeof surfaces)[number], Partial<{
    evidence: string;
    status: string;
    version: string;
  }>>> = {},
): string {
  const rows = surfaces.map((surface) => {
    const override = overrides[surface] ?? {};
    const version = override.version
      ?? (surface === "Full remote tagged flow" ? "v0.1.0" : "qualified-version");
    return `| ${surface} | ${version} | ${override.evidence ?? "qualification evidence"} | ${override.status ?? "Pass"} |`;
  });

  return [
    "# Release qualification",
    "",
    "## Current matrix",
    "",
    "| Surface | Qualified version | Evidence | Status |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "## Owner-only gate",
  ].join("\n");
}

describe("release qualification matrix", () => {
  test("accepts every expected row exactly once when all statuses pass", () => {
    expect(() => validateReleaseQualification(matrix(), "v0.1.0")).not.toThrow();
  });

  for (const status of ["Pending", "Fail"]) {
    test(`rejects a ${status} status`, () => {
      expect(() => validateReleaseQualification(matrix({ Bun: { status } }), "v0.1.0"))
        .toThrow(`Bun status must be Pass, received ${status}`);
    });
  }

  test("rejects a missing expected row", () => {
    const markdown = matrix().replace(
      "| imsg | qualified-version | qualification evidence | Pass |\n",
      "",
    );
    expect(() => validateReleaseQualification(markdown, "v0.1.0"))
      .toThrow("missing expected qualification row: imsg");
  });

  test("rejects a duplicate expected row", () => {
    const row = "| Codex CLI | qualified-version | qualification evidence | Pass |";
    const markdown = matrix().replace(row, `${row}\n${row}`);
    expect(() => validateReleaseQualification(markdown, "v0.1.0"))
      .toThrow("duplicate qualification row: Codex CLI");
  });

  test("rejects remote-flow evidence for a stale release tag", () => {
    expect(() => validateReleaseQualification(
      matrix({ "Full remote tagged flow": { version: "v0.0.9" } }),
      "v0.1.0",
    )).toThrow("Full remote tagged flow must be qualified for exact release tag v0.1.0");
  });

  test("trims cells before validating them", () => {
    const markdown = matrix().replace(
      "| Bun | qualified-version | qualification evidence | Pass |",
      "|   Bun   |   qualified-version   |   qualification evidence   |   Pass   |",
    );
    expect(() => validateReleaseQualification(markdown, "v0.1.0")).not.toThrow();
  });

  test("rejects unknown rows", () => {
    const markdown = matrix().replace(
      "| Full remote tagged flow |",
      "| Unknown surface | qualified-version | qualification evidence | Pass |\n| Full remote tagged flow |",
    );
    expect(() => validateReleaseQualification(markdown, "v0.1.0"))
      .toThrow("unknown qualification row: Unknown surface");
  });

  test("rejects malformed rows", () => {
    const markdown = matrix().replace(
      "| imsg | qualified-version | qualification evidence | Pass |",
      "| imsg | qualified-version | Pass |",
    );
    expect(() => validateReleaseQualification(markdown, "v0.1.0"))
      .toThrow("malformed qualification row");
  });
});
