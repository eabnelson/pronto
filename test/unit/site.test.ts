import { describe, expect, test } from "bun:test";

const siteRoot = new URL("../../site/", import.meta.url);

async function read(name: string): Promise<string> {
  return Bun.file(new URL(name, siteRoot)).text();
}

describe("public landing page", () => {
  test("keeps the pitch minimal and shows exactly two message examples", async () => {
    const html = await read("index.html");

    expect(html).toContain("iMessage Codex or Claude Code.");
    expect(html).toContain("Pick a tag. Message Codex or Claude from any conversation.");
    expect(html.match(/data-example=/g)).toHaveLength(2);
    expect(html).toContain('href="./setup.md"');
    expect(html).toContain(">Help me set up s4imsg</a>");
    expect(html).not.toContain("<script");
  });

  test("provides a complete agent-readable setup handoff", async () => {
    const setup = await read("setup.md");

    expect(setup).toContain("https://github.com/eabnelson/s4imsg.git");
    expect(setup).toContain("bun run src/cli.ts setup");
    expect(setup).toContain("Full Disk Access");
    expect(setup).toContain("doctor");
    expect(setup).toContain("status");
    expect(setup).toContain("Do not type `yes` for me");
    expect(setup).toContain("Do not use `sudo`");
  });

  test("grants setup and installed executables Full Disk Access at the right times", async () => {
    const setup = await read("setup.md");
    const setupCommand = setup.indexOf("bun run src/cli.ts setup");
    const setupPermission = setup.indexOf("terminal or parent app that will run setup");
    const installedPermission = setup.indexOf("exact installed executable");

    expect(setupPermission).toBeGreaterThan(-1);
    expect(setupPermission).toBeLessThan(setupCommand);
    expect(installedPermission).toBeGreaterThan(setupCommand);
  });

  test("guards an existing checkout before running repository code", async () => {
    const setup = await read("setup.md");
    const cloneWithChosenPath = setup.indexOf(
      "git clone https://github.com/eabnelson/s4imsg.git \"$CHECKOUT\"",
    );
    const checkoutUse = setup.indexOf('cd "$CHECKOUT"');
    const originCheck = setup.indexOf("git remote get-url origin");
    const exactOrigins = setup.indexOf(
      "https://github.com/eabnelson/s4imsg.git|git@github.com:eabnelson/s4imsg.git)",
    );
    const cleanCheck = setup.indexOf("git status --porcelain");
    const fastForward = setup.indexOf("git pull --ff-only");
    const install = setup.indexOf("bun install --frozen-lockfile");

    expect(cloneWithChosenPath).toBeGreaterThan(-1);
    expect(checkoutUse).toBeGreaterThan(-1);
    expect(originCheck).toBeGreaterThan(-1);
    expect(exactOrigins).toBeGreaterThan(originCheck);
    expect(cleanCheck).toBeGreaterThan(originCheck);
    expect(fastForward).toBeGreaterThan(cleanCheck);
    expect(install).toBeGreaterThan(fastForward);
  });

  test("makes the final installed status check self-contained", async () => {
    const setup = await read("setup.md");
    const finalStep = setup.slice(setup.indexOf("7. "));

    expect(finalStep).toContain(
      'S4IMSG="$HOME/Library/Application Support/s4imsg/bin/s4imsg"\n   "$S4IMSG" status',
    );
  });
});
