const REQUIRED_CONTROLS = [
  [
    'npm publish "./release-assets/$PACKAGE_FILE" --provenance --access public',
    "npm publication with provenance",
  ],
  ["id-token: write", "OIDC publishing permission"],
  ["npm install --global npm@11.19.1", "trusted-publishing npm CLI"],
  ['test "$(npm --version)" = "11.19.1"', "trusted-publishing npm CLI verification"],
  ["for ATTEMPT in {1..60}; do", "npm registry propagation retry"],
  ["release/pronto-imessage-*.tgz", "package release artifact"],
  ["sha256sum -c pronto-imessage.sha256", "downloaded package checksum verification"],
  ["release/pronto-whatsapp-*.tgz", "WhatsApp package release artifact"],
  ["apps/menubar/scripts/bundle.sh \"$menubar\" --universal --sign-identity \"$identity\"", "universal menu bar app build"],
  ["codesign --verify --deep --strict --verbose=4 -R=\"$requirement\" \"$app\"", "menu bar app designated requirement"],
  ["xcrun stapler staple \"$app\"", "menu bar app notarization ticket"],
  ["release-assets/Pronto-menubar.zip", "menu bar app release asset"],
  ["release-assets/pronto-menubar-update.json", "menu bar app signed manifest"],
  ["sha256sum -c pronto-whatsapp.sha256", "downloaded WhatsApp package checksum verification"],
  [
    'npm publish "./release-assets/$WHATSAPP_PACKAGE_FILE" --provenance --access public',
    "WhatsApp npm publication with provenance",
  ],
  ["environment: release", "protected release environment"],
  ["codesign --force --options runtime --timestamp", "Developer ID hardened-runtime signing"],
  ["grep -Eq '^CodeDirectory .*flags=.*runtime'", "hardened-runtime signature assertion"],
  ["xcrun notarytool submit", "Apple notarization"],
  ["PRONTO_RELEASE_ED25519_PRIVATE_KEY", "signed update manifest credential"],
  ["bun scripts/generate-update-manifest.ts", "signed update manifest generation"],
  ["actions/attest-build-provenance@", "artifact provenance attestation"],
  ["workflow_dispatch:", "manual immutable-tag recovery"],
  ["- \"!v*-candidate.*\"", "candidate tag push exclusion"],
  ["candidate_only:", "explicit candidate-only input"],
  ["if: ${{ inputs.candidate_only != true && !contains(github.ref_name, '-candidate.') }}", "candidate publication fence"],
  ["- name: Verify owner qualification is complete\n        if: ${{ inputs.candidate_only != true }}", "normal-release owner qualification gate"],
  ["- name: Create signed update manifest and checksums\n        if: ${{ inputs.candidate_only != true }}", "candidate update-manifest fence"],
  [
    "ref: ${{ github.ref }}",
    "tag-pinned recovery checkout",
  ],
  [
    'git rev-parse "refs/tags/$RELEASE_TAG^{commit}"',
    "peeled recovery tag verification",
  ],
] as const;

const PUBLISHED_PACKAGES = 2;

const ORDERED_STEPS = [
  "- name: Verify owner qualification is complete",
  "- name: Create signed update manifest and checksums",
  "\n  publish:",
  "- name: Verify downloaded checksum",
  "- name: Create draft release",
  "- name: Upload and verify draft assets",
  "- name: Publish and verify pronto-imessage",
  "- name: Publish and verify pronto-whatsapp",
  "- name: Publish verified release",
] as const;

export function releaseWorkflowViolations(workflow: string): string[] {
  const violations: string[] = [];
  for (const [control, label] of REQUIRED_CONTROLS) {
    if (!workflow.includes(control)) violations.push(`release workflow is missing ${label}`);
  }
  // Each published package waits for its own registry propagation.
  if (workflow.split("for ATTEMPT in {1..60}; do").length - 1 < PUBLISHED_PACKAGES) {
    violations.push("release workflow is missing a registry propagation retry for each package");
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
  if (/NODE_AUTH_TOKEN|secrets\.NPM_TOKEN/.test(workflow)) {
    violations.push("release workflow must use OIDC instead of an npm token");
  }
  return violations;
}
