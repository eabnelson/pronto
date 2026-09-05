import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { renderLaunchAgent, runLaunchctl, stopLaunchAgentForLabel } from "../../packages/cli/src/macos/launch-agent";

// Native lifecycle qualification, opt-in because hosted CI may have no GUI domain.
// No Messages, credentials, models, or production LaunchAgent participates.
test.skipIf(process.platform !== "darwin" || process.env.RUN_LAUNCHD_INTEGRATION !== "1")(
  "graceful unload lets the active child finish beyond launchd's exit deadline",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pronto-launchd-drain-"));
    const label = `dev.pronto.test.${randomUUID()}`;
    const uid = process.getuid!();
    const service = `gui/${uid}/${label}`;
    const marker = join(directory, "state.json");
    const fixture = join(directory, "fixture.ts");
    const plist = join(directory, "fixture.plist");
    try {
      await writeFile(fixture, `
        const marker = ${JSON.stringify(marker)};
        const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(25000)"], {stdout:"ignore",stderr:"ignore"});
        let stop;
        const stopped = new Promise(resolve => {stop=resolve;});
        process.once("SIGTERM", () => stop());
        await Bun.write(marker, JSON.stringify({state:"active",pid:process.pid,child:child.pid}));
        await stopped;
        const exitCode = await child.exited;
        await Bun.write(marker, JSON.stringify({state:"drained",exitCode,pid:process.pid}));
      `, { mode: 0o600 });
      const rendered = renderLaunchAgent({ executablePath: process.execPath,
        logPath: join(directory, "fixture.log"), runtimeExecutablePaths: [] })
        .replace("dev.pronto.agent", label)
        .replace("<string>run</string>", `<string>${fixture}</string>`);
      await writeFile(plist, rendered, { mode: 0o600 });
      await chmod(directory, 0o700);
      const boot = await runLaunchctl(["bootstrap", `gui/${uid}`, plist]);
      expect(boot.exitCode).toBe(0);
      const startupDeadline = Date.now() + 10_000;
      while (Date.now() < startupDeadline) {
        const state = await readFile(marker, "utf8").catch(() => "");
        if (state.includes('"active"')) break;
        await Bun.sleep(25);
      }
      expect(JSON.parse(await readFile(marker, "utf8")).state).toBe("active");
      await stopLaunchAgentForLabel({ label, uid });
      expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({ state: "drained", exitCode: 0 });
      expect((await runLaunchctl(["print", service])).exitCode).not.toBe(0);
    } finally {
      await runLaunchctl(["bootout", service]);
      await runLaunchctl(["enable", service]);
      await rm(directory, { recursive: true, force: true });
    }
  },
  45_000,
);
