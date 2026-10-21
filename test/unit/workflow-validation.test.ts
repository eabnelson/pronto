import { describe, expect, test } from "bun:test";
import { mutableActionReferences } from "../../scripts/workflow-validation";

describe("workflow action validation", () => {
  test("build workflows install the helper's Go toolchain before compiling", async () => {
    for (const name of ["ci", "release", "pages"]) {
      const workflow = await Bun.file(new URL(`../../.github/workflows/${name}.yml`, import.meta.url)).text();
      expect(mutableActionReferences(workflow)).toEqual([]);
      if (name === "pages") continue; // Static site deployment does not compile native code.
      const setup = workflow.indexOf("uses: actions/setup-go@");
      const build = workflow.indexOf("run: bun run build");
      expect(setup).toBeGreaterThan(-1);
      expect(setup).toBeLessThan(build);
      expect(workflow.slice(0, build)).toContain("runs-on: macos-15");
      const configuration = workflow.slice(setup, workflow.indexOf("\n      - ", setup));
      expect(configuration).toContain("go-version-file: packages/slack/native/go.mod");
      expect(configuration).toContain("cache-dependency-path: packages/slack/native/go.sum");
    }
  });

  test("rejects mutable actions in list-item and id-prefixed steps", () => {
    const workflow = `
steps:
  - uses: actions/checkout@v4
  - id: deployment
    uses: actions/deploy-pages@v5
`;

    expect(mutableActionReferences(workflow)).toEqual([
      "actions/checkout@v4",
      "actions/deploy-pages@v5",
    ]);
  });

  test("accepts immutable and local action references", () => {
    const workflow = `
steps:
  - uses: ./local-action
  - id: deployment
    uses: actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5
`;

    expect(mutableActionReferences(workflow)).toEqual([]);
  });
});

test("CI and release builds scan the native Slack helper for known vulnerabilities", async () => {
  for (const name of ["ci", "release"]) {
    const configuration = await Bun.file(new URL(`../../.github/workflows/${name}.yml`, import.meta.url)).text();
    expect(configuration).toContain("go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...");
    expect(configuration).toContain("working-directory: packages/slack/native");
  }
});
