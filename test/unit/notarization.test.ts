import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each([
  { name: "retries a transient Apple ticket failure", failures: 1, code: 68, validation: 0, exit: 0, attempts: 2, validations: 1, waits: 1 },
  { name: "fails after three transient failures", failures: 9, code: 68, validation: 0, exit: 68, attempts: 3, validations: 0, waits: 2 },
  { name: "fails immediately for invalid app errors", failures: 1, code: 65, validation: 0, exit: 65, attempts: 1, validations: 0, waits: 0 },
  { name: "never accepts a failed ticket validation", failures: 0, code: 68, validation: 65, exit: 65, attempts: 1, validations: 1, waits: 0 },
])("notarization: $name", async (scenario) => {
  const directory = await mkdtemp(join(tmpdir(), "pronto-stapler-"));
  const calls = join(directory, "calls");
  try {
    await writeFile(calls, "");
    await writeFile(join(directory, "xcrun"), `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == stapler && "$3" == fixture.app ]]
printf '%s\n' "$2" >> "$TEST_CALLS"
if [[ "$2" == staple ]]; then
  count=0
  if [[ -f "$TEST_COUNTER" ]]; then read -r count < "$TEST_COUNTER"; fi
  count=$((count+1))
  printf '%s\n' "$count" > "$TEST_COUNTER"
  if (( count <= TEST_FAILURES )); then exit "$TEST_ERROR"; fi
else
  exit "$TEST_VALIDATION"
fi
`, { mode: 0o700 });
    await writeFile(join(directory, "sleep"), '#!/usr/bin/env bash\nprintf "wait %s\\n" "$1" >> "$TEST_CALLS"\n', { mode: 0o700 });
    const child = Bun.spawn(["bash", new URL("../../scripts/staple-notarized-app.sh", import.meta.url).pathname, "fixture.app"], {
      env: { ...process.env, PATH: `${directory}:/usr/bin:/bin`, TEST_CALLS: calls, TEST_COUNTER: join(directory, "counter"), TEST_FAILURES: String(scenario.failures), TEST_ERROR: String(scenario.code), TEST_VALIDATION: String(scenario.validation) },
      stdout: "ignore", stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exit).toBe(scenario.exit);
    const operations = (await readFile(calls, "utf8")).trim().split("\n");
    expect(operations.filter((operation) => operation === "staple")).toHaveLength(scenario.attempts);
    expect(operations.filter((operation) => operation === "validate")).toHaveLength(scenario.validations);
    expect(operations.filter((operation) => operation === "wait 10")).toHaveLength(scenario.waits);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
