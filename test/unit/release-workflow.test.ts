import { describe, expect, test } from "bun:test";
import { releaseWorkflowViolations } from "../../scripts/release-workflow-validation";

const repoRoot = new URL("../../", import.meta.url);

async function releaseWorkflow(): Promise<string> {
  return Bun.file(new URL(".github/workflows/release.yml", repoRoot)).text();
}

describe("release workflow", () => {
  test("uses draft-aware release lookups before publishing", async () => {
    const workflow = await releaseWorkflow();
    const beforePublish = workflow.split("      - name: Publish verified release")[0]!;
    const listLookups = beforePublish.match(
      /gh api --paginate "repos\/\$GH_REPO\/releases\?per_page=100"/g,
    );

    expect(listLookups).toHaveLength(2);
    expect(beforePublish).not.toContain("releases/tags/$RELEASE_TAG");
    expect(beforePublish).toContain('--arg tag "$RELEASE_TAG"');
    expect(beforePublish).toContain(".tag_name == $tag");
    expect(beforePublish).toContain(".draft == true");
    expect(beforePublish).toContain('([.assets[].name] | sort) == ([');
    expect(beforePublish).toContain('$package');
    expect(workflow).toContain("./dist/s4imsg --version");
    expect(workflow).toContain("dist/s4imsg.sha256");
    expect(workflow).toContain("dist/pronto-imessage-*.tgz");
  });

  test("keeps releases immutable and verifies the published release", async () => {
    const workflow = await releaseWorkflow();

    expect(workflow).toContain("Refuse to mutate an existing release");
    expect(workflow).toContain("gh release create \"$RELEASE_TAG\" --draft");
    expect(workflow).toContain('gh release edit "$RELEASE_TAG" --draft=false');
    expect(workflow).toContain(
      'gh api "repos/$GH_REPO/releases/tags/$RELEASE_TAG" --jq \'.draft\'',
    );
    expect(workflow).toContain('test "$REMOTE_SHASUM" = "$LOCAL_SHASUM"');
  });

  test("orders qualification, draft verification, package publication, and release publication", async () => {
    const workflow = await releaseWorkflow();
    expect(releaseWorkflowViolations(workflow)).toEqual([]);
  });

  test("rejects missing publication controls and reordered publication", async () => {
    const workflow = await releaseWorkflow();
    for (const control of [
      'npm publish "./release-assets/$PACKAGE_FILE" --provenance --access public',
      "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
      "id-token: write",
      "dist/pronto-imessage-*.tgz",
      "sha256sum -c pronto-imessage.sha256",
      "workflow_dispatch:",
      "ref: ${{ inputs.release_tag || github.ref }}",
    ]) {
      expect(releaseWorkflowViolations(workflow.replace(control, "removed-control")))
        .not.toEqual([]);
    }
    const reordered = workflow
      .replace("- name: Publish and verify pronto-imessage", "- name: temporary-step")
      .replace("- name: Create draft release", "- name: Publish and verify pronto-imessage")
      .replace("- name: temporary-step", "- name: Create draft release");
    expect(releaseWorkflowViolations(reordered)).toContain(
      "release workflow step is out of order: - name: Upload and verify draft assets",
    );
    const unverifiedDraft = workflow
      .replace("- name: Verify downloaded checksum", "- name: temporary-step")
      .replace("- name: Create draft release", "- name: Verify downloaded checksum")
      .replace("- name: temporary-step", "- name: Create draft release");
    expect(releaseWorkflowViolations(unverifiedDraft)).toContain(
      "release workflow step is out of order: - name: Create draft release",
    );
  });

  test("manual recovery rebuilds an explicit immutable tag", async () => {
    const workflow = await releaseWorkflow();

    expect(workflow).toContain("release_tag:");
    expect(workflow).toContain("RELEASE_TAG: ${{ inputs.release_tag || github.ref_name }}");
    expect(workflow).toContain("ref: ${{ inputs.release_tag || github.ref }}");
    expect(workflow).toContain('test "v$VERSION" = "$RELEASE_TAG"');
    expect(workflow).toContain('echo "release-tag=$RELEASE_TAG" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("RELEASE_TAG: ${{ needs.build.outputs.release-tag }}");
    expect(workflow).toContain('--title "Pronto $RELEASE_TAG"');
    expect(workflow).not.toContain("$GITHUB_REF_NAME");
  });
});
