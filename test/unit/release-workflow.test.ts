import { expect, test } from "bun:test";
import { releaseWorkflowViolations } from "../../scripts/release-workflow-validation";

const workflow = await Bun.file(new URL("../../.github/workflows/release.yml", import.meta.url)).text();

test("the release workflow preserves signing, qualification and candidate publication fences", () => {
  expect(releaseWorkflowViolations(workflow)).toEqual([]);
});

test("each publish job verifies the Node version it installs", () => {
  for (const name of ["publish", "publish-npm-existing"]) {
    const publish = workflow.split(`\n  ${name}:`)[1]!;
    const installedVersion = publish.match(/node-version:\s*([^\s]+)/)?.[1];
    expect(installedVersion).toBeDefined();
    expect(publish).toContain(`test "$(node --version)" = "v${installedVersion}"`);
  }
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

test("npm recovery requires a public stable release and its original signed build provenance", () => {
  const recovery = workflow.split("\n  publish-npm-existing:")[1]!;
  expect(recovery).toContain("github.event_name == 'workflow_dispatch'");
  expect(recovery).toContain("github.ref == 'refs/heads/main'");
  expect(recovery).toContain("inputs.npm_only_tag != '' && inputs.candidate_only != true");
  expect(recovery).toContain('.isDraft == false and .isPrerelease == false');
  expect(recovery).toContain('sha256sum -c "$PACKAGE_NAME.sha256"');
  expect(recovery).toContain('--source-ref "refs/tags/$RELEASE_TAG" --source-digest "$SOURCE_SHA"');
  expect(recovery).toContain('--signer-workflow "$GH_REPO/.github/workflows/release.yml"');
  expect(recovery).toContain('test "$REMOTE_SHASUM" = "$LOCAL_SHASUM"');
});

test("npm recovery bounds stalled writes and cannot alter release assets or tags", () => {
  const recovery = workflow.split("\n  publish-npm-existing:")[1]!;
  expect(recovery).toContain("timeout-minutes: 10");
  expect(recovery).toContain("timeout 150s npm publish");
  expect(recovery).toContain('NPM_CONFIG_FETCH_TIMEOUT: "30000"');
  expect(recovery).toContain("contents: read");
  expect(recovery).toContain("id-token: write");
  expect(recovery).toContain("fail-fast: false");
  expect(recovery).not.toMatch(/gh release (?:create|edit|upload|delete)|git (?:push|tag)|contents: write/);
});
