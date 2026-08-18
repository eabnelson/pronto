import { describe, expect, test } from "bun:test";
import { mutableActionReferences } from "../../scripts/workflow-validation";

describe("workflow action validation", () => {
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
