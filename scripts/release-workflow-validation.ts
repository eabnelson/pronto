const REQUIRED_CONTROLS = [
  [
    'npm publish "./release-assets/$PACKAGE_FILE" --provenance --access public',
    "npm publication with provenance",
  ],
  ["NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}", "npm authentication"],
  ["id-token: write", "OIDC provenance permission"],
  ["dist/pronto-imessage-*.tgz", "package release artifact"],
  ["sha256sum -c pronto-imessage.sha256", "downloaded package checksum verification"],
  ["workflow_dispatch:", "manual immutable-tag recovery"],
  ["ref: ${{ inputs.release_tag || github.ref }}", "tag-pinned recovery checkout"],
] as const;

const ORDERED_STEPS = [
  "- name: Verify owner qualification is complete",
  "- name: Create and verify checksum",
  "\n  publish:",
  "- name: Verify downloaded checksum",
  "- name: Create draft release",
  "- name: Upload and verify draft assets",
  "- name: Publish and verify pronto-imessage",
  "- name: Publish verified release",
] as const;

export function releaseWorkflowViolations(workflow: string): string[] {
  const violations: string[] = [];
  for (const [control, label] of REQUIRED_CONTROLS) {
    if (!workflow.includes(control)) violations.push(`release workflow is missing ${label}`);
  }

  let previous = -1;
  for (const step of ORDERED_STEPS) {
    const index = workflow.indexOf(step);
    if (index < 0) {
      violations.push(`release workflow is missing ordered step: ${step.trim()}`);
    } else if (index <= previous) {
      violations.push(`release workflow step is out of order: ${step.trim()}`);
    }
    previous = Math.max(previous, index);
  }
  const publishJob = workflow.indexOf("\n  publish:");
  const npmPublish = workflow.indexOf("npm publish");
  if (npmPublish >= 0 && (publishJob < 0 || npmPublish <= publishJob)) {
    violations.push("npm publication must run only in the dependent publish job");
  }
  return violations;
}
