import { describe, expect, test } from "bun:test";

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
    expect(beforePublish).not.toContain("releases/tags/$GITHUB_REF_NAME");
    expect(beforePublish).toContain('--arg tag "$GITHUB_REF_NAME"');
    expect(beforePublish).toContain(".tag_name == $tag");
    expect(beforePublish).toContain(".draft == true");
    expect(beforePublish).toContain(
      '([.assets[].name] | sort) == ["pronto", "pronto.sha256"]',
    );
  });

  test("keeps releases immutable and verifies the published release", async () => {
    const workflow = await releaseWorkflow();

    expect(workflow).toContain("Refuse to mutate an existing release");
    expect(workflow).toContain("gh release create \"$GITHUB_REF_NAME\" --draft");
    expect(workflow).toContain('gh release edit "$GITHUB_REF_NAME" --draft=false');
    expect(workflow).toContain(
      'gh api "repos/$GH_REPO/releases/tags/$GITHUB_REF_NAME" --jq \'.draft\'',
    );
  });
});
