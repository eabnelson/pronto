import { expect, test } from "bun:test";
import { releaseWorkflowViolations } from "../../scripts/release-workflow-validation";

const workflow = await Bun.file(new URL("../../.github/workflows/release.yml", import.meta.url)).text();

test("the release workflow preserves signing, qualification and candidate publication fences", () => {
  expect(releaseWorkflowViolations(workflow)).toEqual([]);
});

test("draft verification and immutable publication retain their remote integrity checks", () => {
  const beforePublish = workflow.split("      - name: Publish verified release")[0]!;
  expect(beforePublish.split('gh api --paginate "repos/$GH_REPO/releases?per_page=100"').length - 1).toBe(2);
  for (const control of [
    ".draft == true",
    "([.assets[].name] | sort) == ([",
    "Refuse to mutate an existing release",
    'test "$REMOTE_SHASUM" = "$LOCAL_SHASUM"',
  ]) expect(workflow).toContain(control);
});

test("removing publication controls or reordering publication fails validation", () => {
  for (const control of [
    'npm publish "./release-assets/$PACKAGE_FILE" --provenance --access public',
    "id-token: write",
    "for ATTEMPT in {1..60}; do",
    "sha256sum -c pronto-imessage.sha256",
    "workflow_dispatch:",
    "ref: ${{ github.ref }}",
    'git rev-parse "refs/tags/$RELEASE_TAG^{commit}"',
    "if: ${{ inputs.candidate_only != true && !contains(github.ref_name, '-candidate.') }}",
  ]) expect(releaseWorkflowViolations(workflow.replace(control, "removed-control"))).not.toEqual([]);

  for (const step of [
    "Verify owner qualification is complete",
    "Require Slack qualification before publishing",
    "Create signed update manifest and checksums",
  ]) {
    const guarded = "- name: " + step + "\n        if: ${{ inputs.candidate_only != true }}";
    expect(releaseWorkflowViolations(workflow.replace(guarded, "- name: " + step))).not.toEqual([]);
  }

  expect(releaseWorkflowViolations(workflow + "\nNODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}")).not.toEqual([]);
  const reordered = workflow
    .replace("- name: Publish and verify pronto-imessage", "- name: temporary-step")
    .replace("- name: Create draft release", "- name: Publish and verify pronto-imessage")
    .replace("- name: temporary-step", "- name: Create draft release");
  expect(releaseWorkflowViolations(reordered)).not.toEqual([]);
});
