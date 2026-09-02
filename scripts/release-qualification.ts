const expectedSurfaces = new Set([
  "macOS",
  "Bun",
  "Node.js",
  "imsg",
  "Codex CLI",
  "Claude Code",
  "Codex effective local probe",
  "Claude effective local probe",
  "Messages Automation",
  "Self-chat mirror handling",
  "Full remote tagged flow",
]);
const semverTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function cellsFor(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function matrixLines(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const headings = lines
    .map((line, index) => ({ index, line: line.trim() }))
    .filter(({ line }) => line === "## Current matrix");
  if (headings.length !== 1) {
    throw new Error("release qualification must contain exactly one Current matrix section");
  }

  const sectionStart = headings[0]!.index + 1;
  const sectionEnd = lines.findIndex(
    (line, index) => index >= sectionStart && /^##\s+/.test(line.trim()),
  );
  const section = lines.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
  const headerIndex = section.findIndex((line) => line.trim().length > 0);
  if (headerIndex === -1) throw new Error("release qualification matrix is missing");

  const table: string[] = [];
  for (const line of section.slice(headerIndex)) {
    if (line.trim().length === 0) break;
    table.push(line);
  }
  return table;
}

export function validateReleaseQualification(markdown: string, releaseTag: string): void {
  if (!semverTag.test(releaseTag)) {
    throw new Error(`release tag must be valid semver prefixed with v: ${releaseTag}`);
  }

  const lines = matrixLines(markdown);
  const header = cellsFor(lines[0] ?? "");
  if (header === null || header.join("|") !== "Surface|Qualified version|Evidence|Status") {
    throw new Error("release qualification matrix has an unexpected header");
  }

  const divider = cellsFor(lines[1] ?? "");
  if (divider === null || divider.length !== 4 || divider.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
    throw new Error("release qualification matrix has a malformed divider");
  }

  const seen = new Set<string>();
  for (const [index, line] of lines.slice(2).entries()) {
    const cells = cellsFor(line);
    if (cells === null || cells.length !== 4 || cells.some((cell) => cell.length === 0)) {
      throw new Error(`malformed qualification row at matrix line ${index + 3}`);
    }

    const [surface, qualifiedVersion, _evidence, status] = cells as [string, string, string, string];
    if (!expectedSurfaces.has(surface)) {
      throw new Error(`unknown qualification row: ${surface}`);
    }
    if (seen.has(surface)) throw new Error(`duplicate qualification row: ${surface}`);
    seen.add(surface);

    if (status !== "Pass") {
      throw new Error(`${surface} status must be Pass, received ${status}`);
    }
    if (surface === "Full remote tagged flow" && qualifiedVersion !== releaseTag) {
      throw new Error(`Full remote tagged flow must be qualified for exact release tag ${releaseTag}`);
    }
  }

  for (const surface of expectedSurfaces) {
    if (!seen.has(surface)) throw new Error(`missing expected qualification row: ${surface}`);
  }
}

if (import.meta.main) {
  const [path, releaseTag] = Bun.argv.slice(2);
  if (path === undefined || releaseTag === undefined) {
    console.error("usage: bun scripts/release-qualification.ts <matrix-path> <release-tag>");
    process.exit(2);
  }

  try {
    validateReleaseQualification(await Bun.file(path).text(), releaseTag);
    console.log(`release qualification passed for ${releaseTag}`);
  } catch (error) {
    console.error(`release qualification failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
