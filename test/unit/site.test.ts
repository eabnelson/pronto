import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

const repoRoot = new URL("../../", import.meta.url);
const siteRoot = new URL("site/", repoRoot);
const setupPrompt =
  "Help me set up iMessage Tags on this Mac. Follow https://studiofour.io/imessage-setup.md and stay with me until one tagged iMessage or RCS message gets exactly one agent reply.";

async function read(name: string): Promise<string> {
  return Bun.file(new URL(name, siteRoot)).text();
}

type FakeEvent = {
  animationName?: string;
  matches?: boolean;
  preventDefault(): void;
};

type Listener = {
  callback: (event: FakeEvent) => unknown;
  once: boolean;
};

class FakeEventTarget {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(
    type: string,
    callback: (event: FakeEvent) => unknown,
    options?: { once?: boolean },
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ callback, once: options?.once === true });
    this.listeners.set(type, listeners);
  }

  async dispatch(type: string, event: Partial<FakeEvent> = {}): Promise<void> {
    const dispatchedEvent: FakeEvent = {
      preventDefault: () => undefined,
      ...event,
    };
    const listeners = [...(this.listeners.get(type) ?? [])];

    for (const listener of listeners) {
      await listener.callback(dispatchedEvent);
      if (listener.once) {
        this.listeners.set(
          type,
          (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
        );
      }
    }
  }
}

class FakeStyle {
  position = "";
  opacity = "";
  readonly properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? "";
  }
}

class FakeElement extends FakeEventTarget {
  readonly animations: Array<{
    canceled: boolean;
    keyframes: Array<Record<string, number | string>>;
    options: Record<string, number | string>;
  }> = [];
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style = new FakeStyle();
  className = "";
  href = "";
  offsetHeight = 40;
  offsetTop = 780;
  offsetWidth = 220;
  parent: FakeElement | undefined;
  textContent = "";
  value = "";

  get childElementCount(): number {
    return this.children.length;
  }

  getBoundingClientRect(): { bottom: number; top: number } {
    return { bottom: this.offsetTop + this.offsetHeight, top: this.offsetTop };
  }

  animate(
    keyframes: Array<Record<string, number | string>>,
    options: Record<string, number | string>,
  ): { cancel(): void } {
    const animation = {
      canceled: false,
      keyframes,
      options,
    };
    this.animations.push(animation);
    return {
      cancel: () => {
        animation.canceled = true;
      },
    };
  }

  append(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }

  replaceChildren(): void {
    for (const child of this.children) child.parent = undefined;
    this.children.length = 0;
  }

  select(): void {}
}

class FakeMediaQueryList extends FakeEventTarget {
  constructor(public matches: boolean) {
    super();
  }

  async change(matches: boolean): Promise<void> {
    this.matches = matches;
    await this.dispatch("change", { matches });
  }
}

class FakeDocument extends FakeEventTarget {
  readonly body = new FakeElement();
  hidden = false;

  constructor(
    readonly stream: FakeElement,
    readonly copyButton: FakeElement,
  ) {
    super();
  }

  querySelector(selector: string): FakeElement | undefined {
    if (selector === "[data-bubble-stream]") return this.stream;
    if (selector === "#copy-prompt") return this.copyButton;
    return undefined;
  }

  createElement(): FakeElement {
    return new FakeElement();
  }

  execCommand(): boolean {
    return true;
  }
}

class FakeWindow extends FakeEventTarget {
  readonly assignedLocations: string[] = [];
  readonly motionPreference: FakeMediaQueryList;
  readonly timers = new Map<number, () => void>();
  innerHeight = 844;
  innerWidth = 1200;
  private nextTimer = 1;

  readonly location = {
    assign: (href: string) => this.assignedLocations.push(href),
  };

  constructor(reducedMotion = false) {
    super();
    this.motionPreference = new FakeMediaQueryList(reducedMotion);
  }

  matchMedia(): FakeMediaQueryList {
    return this.motionPreference;
  }

  setTimeout(callback: () => void): number {
    const timer = this.nextTimer;
    this.nextTimer += 1;
    this.timers.set(timer, callback);
    return timer;
  }

  clearTimeout(timer: number | undefined): void {
    if (timer !== undefined) this.timers.delete(timer);
  }

  runNextTimer(): void {
    const next = this.timers.entries().next().value as [number, () => void] | undefined;
    if (!next) throw new Error("expected a scheduled timer");
    const [timer, callback] = next;
    this.runTimer(timer, callback);
  }

  runTimer(timer: number, callback = this.timers.get(timer)): void {
    if (!callback) throw new Error(`expected timer ${timer}`);
    this.timers.delete(timer);
    callback();
  }
}

type LandingPageHarness = {
  copyButton: FakeElement;
  copiedText: string[];
  document: FakeDocument;
  motionPreference: FakeMediaQueryList;
  stream: FakeElement;
  window: FakeWindow;
};

async function createLandingPageHarness(options: {
  clipboardRejects?: boolean;
  innerWidth?: number;
  reducedMotion?: boolean;
} = {}): Promise<LandingPageHarness> {
  const html = await read("index.html");
  const openMarker = "<script>";
  const closeMarker = "</script>";
  const scriptStart = html.indexOf(openMarker);
  const scriptEnd = html.indexOf(closeMarker, scriptStart + openMarker.length);
  if (scriptStart === -1 || scriptEnd <= scriptStart + openMarker.length) {
    throw new Error("landing page inline script markers are missing or invalid");
  }
  const script = html.slice(scriptStart + openMarker.length, scriptEnd);

  const stream = new FakeElement();
  const copyButton = new FakeElement();
  copyButton.href = "https://example.test/setup.md";
  copyButton.offsetHeight = 54;
  copyButton.offsetTop = 180;
  copyButton.textContent = "Help me get set up";
  const document = new FakeDocument(stream, copyButton);
  const window = new FakeWindow(options.reducedMotion);
  window.innerWidth = options.innerWidth ?? window.innerWidth;
  const copiedText: string[] = [];
  const navigator = {
    clipboard: {
      writeText: async (text: string) => {
        if (options.clipboardRejects) throw new Error("clipboard unavailable");
        copiedText.push(text);
      },
    },
  };

  Function("document", "window", "navigator", script)(document, window, navigator);

  return {
    copyButton,
    copiedText,
    document,
    motionPreference: window.motionPreference,
    stream,
    window,
  };
}

describe("public landing page", () => {
  test("deploys the site directory to GitHub Pages from main", async () => {
    const workflow = await Bun.file(
      new URL(".github/workflows/pages.yml", repoRoot),
    ).text();

    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("pages: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).toContain("name: github-pages");
    expect(workflow).toMatch(/^\s+path: site$/m);
    expect(workflow).toContain("needs: verify");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("actions/upload-pages-artifact@");
    expect(workflow).toContain("actions/deploy-pages@");
    expect(workflow.indexOf("- run: bun run build")).toBeLessThan(
      workflow.indexOf("- run: bun run release:validate"),
    );
  });

  test("keeps the hero minimal and points to the setup prompt", async () => {
    const html = await read("index.html");

    expect(html).toContain(">Pick any tag</h1>");
    expect(html).toContain("iMessage your agent from any conversation");
    expect(html).toContain('id="copy-prompt"');
    expect(html).toContain('href="https://studiofour.io/imessage-setup.md"');
    expect(html).toContain(">Help me get set up</a>");
    expect(html).toContain("https://studiofour.io/imessage-setup.md");
    expect(html).toContain("overflow-x: hidden");
    expect(html).toContain("overflow-y: auto");
    expect(html).not.toContain('class="mark"');
  });

  test("publishes a bubble-only social preview", async () => {
    const html = await read("index.html");
    const source = await read("og-image.svg");
    const sourceBytes = new Uint8Array(
      await Bun.file(new URL("og-image.svg", siteRoot)).arrayBuffer(),
    );
    const png = new Uint8Array(await Bun.file(new URL("og-image.png", siteRoot)).arrayBuffer());
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);

    expect(html).toContain(
      '<meta property="og:image" content="https://studiofour.io/imessage-og.png">',
    );
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain(
      '<meta name="twitter:image" content="https://studiofour.io/imessage-og.png">',
    );
    expect(source).toContain('viewBox="0 0 1200 630"');
    expect(source).toContain("@codex");
    expect(source).toContain("@claude");
    expect(source).toContain("@plan");
    expect(source).toContain("#0a84ff");
    expect(source).toContain("#e5e5ea");
    expect(source).not.toContain(">pronto<");
    expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(
      "7d3642d252cbf645f065dc39ef896d3329086548056fe7f2009b31fc4b05945b",
    );
    expect(createHash("sha256").update(png).digest("hex")).toBe(
      "35c89432a4d86da90db84ba2600d3724e35f58f41dc7fae26456421e4fc7daaa",
    );
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);
  });

  test("keeps the send entrance separate from the rising fade timeline", async () => {
    const html = await read("index.html");

    expect(html).toContain('data-bubble-stream');
    expect(html).toContain("@codex");
    expect(html).toContain("@claude");
    expect(html).toContain("@plan");
    expect(html).toContain("--rotation");
    expect(html).toContain("@keyframes send-bubble-cycle");
    expect(html).toContain("send-bubble-cycle var(--duration)");
    expect(html).toContain("transform: translate3d(0, 18px, 0) scale(0.82)");
    expect(html).toContain("frame(0, 1)");
    expect(html).not.toContain("translateY(${entranceLift}px)");
    expect(html).toContain("align-items: start");
    expect(html).toContain("bubble.animate(keyframes");
    expect(html).toContain("iterations: Number.POSITIVE_INFINITY");
    expect(html).toContain("transform: `translate3d(");
    expect(html).toContain('copyButton.getBoundingClientRect().bottom');
    expect(html).toContain("if (window.innerWidth === layoutWidth) return");
    expect(html).not.toContain("68% {\n          opacity: 0;");
    expect(html).not.toContain("setInterval");
    expect(html).not.toContain(".hero::before");
    expect(html).not.toContain(".bubble.incoming::after");
    expect(html).not.toContain(".bubble.outgoing::after");
  });

  test("copies the exact setup prompt and restores the setup label", async () => {
    const harness = await createLandingPageHarness();

    await harness.copyButton.dispatch("click");

    expect(harness.copiedText).toEqual([setupPrompt]);
    expect(harness.copyButton.textContent).toBe("Copied prompt");
    expect(harness.copyButton.dataset.copied).toBe("true");
    expect(harness.window.assignedLocations).toEqual([]);

    const resetTimer = Math.max(...harness.window.timers.keys());
    harness.window.runTimer(resetTimer);

    expect(harness.copyButton.textContent).toBe("Help me get set up");
    expect(harness.copyButton.dataset.copied).toBeUndefined();
  });

  test("opens the setup guide and clears copied state when clipboard access fails", async () => {
    const harness = await createLandingPageHarness({ clipboardRejects: true });
    harness.copyButton.dataset.copied = "true";

    await harness.copyButton.dispatch("click");

    expect(harness.copyButton.dataset.copied).toBeUndefined();
    expect(harness.copyButton.textContent).toBe("Opening setup guide…");
    expect(harness.window.assignedLocations).toEqual([harness.copyButton.href]);
  });

  test("starts one bubble immediately and keeps a continuous staggered stream", async () => {
    const harness = await createLandingPageHarness();

    expect(harness.stream.childElementCount).toBe(12);
    const delays = harness.stream.children.map((bubble) =>
      Number.parseFloat(bubble.style.properties.get("--delay") ?? ""),
    );
    expect(delays.filter((delay) => delay <= 0)).toHaveLength(1);
    expect(delays).toEqual([...delays].sort((left, right) => left - right));
    const intervals = delays.slice(1).map((delay, index) => delay - delays[index]!);
    expect(Math.min(...intervals)).toBeGreaterThanOrEqual(1.25);
    expect(harness.window.timers.size).toBe(0);
    expect(harness.stream.children.every((bubble) => bubble.animations.length === 1)).toBe(
      true,
    );
    for (const bubble of harness.stream.children) {
      const animation = bubble.animations[0];
      const keyframes = animation?.keyframes;
      expect(animation?.options.easing).toBe("linear");
      expect(keyframes?.[0]).toMatchObject({
        opacity: 1,
        transform: expect.stringContaining("translate3d"),
      });
      for (const frame of keyframes ?? []) {
        expect(frame.easing).toBeUndefined();
        const transform = String(frame.transform ?? "");
        expect(transform).not.toContain("translateY");
        expect(transform).not.toContain("scale");
      }
    }

    harness.document.hidden = true;
    await harness.document.dispatch("visibilitychange");
    expect(harness.stream.childElementCount).toBe(12);
    expect(harness.window.timers.size).toBe(0);
  });

  test("advances inspiration without replacing the looping bubble", async () => {
    const harness = await createLandingPageHarness();
    const bubble = harness.stream.children[0];
    const bubbleBody = bubble?.children[0];
    if (!bubble || !bubbleBody) throw new Error("expected an animated bubble");
    const initialText = bubbleBody.textContent;

    await bubbleBody.dispatch("animationiteration");

    expect(harness.stream.childElementCount).toBe(12);
    expect(harness.stream.children[0]).toBe(bubble);
    expect(bubbleBody.textContent).not.toBe(initialText);
  });

  test("anchors the mobile fade endpoint to the setup button position", async () => {
    const harness = await createLandingPageHarness({ innerWidth: 390 });
    const bubble = harness.stream.children[0];
    if (!bubble) throw new Error("expected an animated bubble");
    const animation = bubble.animations[0];
    if (!animation) throw new Error("expected a bubble animation");
    const fadeFrame = animation.keyframes.find(
      (frame) =>
        frame.opacity === 0 && Number(frame.offset) > 0.05 && Number(frame.offset) < 1,
    );
    const expectedFadeEnd =
      (bubble.offsetTop - harness.copyButton.getBoundingClientRect().bottom) /
      (harness.window.innerHeight * 0.85);

    expect(Number(fadeFrame?.offset)).toBeCloseTo(expectedFadeEnd);
    expect(animation.keyframes[0]?.transform).toContain("translate3d");
    expect(animation.options.duration).toBe(16_800);
    expect(animation.options.iterations).toBe(Number.POSITIVE_INFINITY);
  });

  test("does not restart bubbles during a height-only mobile resize", async () => {
    const harness = await createLandingPageHarness({ innerWidth: 390 });
    const bubbles = [...harness.stream.children];

    await harness.window.dispatch("resize");

    expect(harness.stream.children).toEqual(bubbles);
    expect(bubbles.every((bubble) => bubble.animations.length === 1)).toBe(true);
    expect(
      bubbles.every((bubble) => bubble.animations.every((animation) => !animation.canceled)),
    ).toBe(true);
  });

  test("responds to live reduced-motion changes", async () => {
    const harness = await createLandingPageHarness();

    await harness.motionPreference.change(true);
    expect(harness.stream.childElementCount).toBe(8);
    expect(harness.window.timers.size).toBe(0);
    expect(harness.stream.children.every((bubble) => bubble.dataset.static === "true")).toBe(true);

    await harness.motionPreference.change(false);
    expect(harness.stream.childElementCount).toBe(12);
    expect(harness.window.timers.size).toBe(0);
    expect(harness.stream.children.every((bubble) => bubble.dataset.static === undefined)).toBe(true);
    expect(
      harness.stream.children.every(
        (bubble) =>
          bubble.style.properties.has("--duration") &&
          Number.parseFloat(bubble.style.properties.get("--delay") ?? "") >= 0,
      ),
    ).toBe(true);
    expect(harness.stream.children[0]?.style.properties.get("--delay")).toBe("0s");
  });

  test("provides a complete agent-readable setup handoff", async () => {
    const setup = await read("setup.md");

    expect(setup).toContain("https://github.com/eabnelson/pronto.git");
    expect(setup).toContain("bun run packages/cli/src/cli.ts setup");
    expect(setup).toContain("Full Disk Access");
    expect(setup).toContain("doctor");
    expect(setup).toContain("status");
    expect(setup).toContain("Do not type `yes` for me");
    expect(setup).toContain("Do not use `sudo`");
    expect(setup).toContain("iMessage or RCS");
    expect(setup).toContain("SMS messages do not activate Pronto");
  });

  test("grants setup and installed executables Full Disk Access at the right times", async () => {
    const setup = await read("setup.md");
    const setupCommand = setup.indexOf("bun run packages/cli/src/cli.ts setup");
    const setupPermission = setup.indexOf("terminal or parent app that will run setup");
    const installedPermission = setup.indexOf("exact installed executable");

    expect(setupPermission).toBeGreaterThan(-1);
    expect(setupPermission).toBeLessThan(setupCommand);
    expect(installedPermission).toBeGreaterThan(setupCommand);
  });

  test("guards an existing checkout before running repository code", async () => {
    const setup = await read("setup.md");
    const cloneWithChosenPath = setup.indexOf(
      "git clone https://github.com/eabnelson/pronto.git \"$CHECKOUT\"",
    );
    const checkoutUse = setup.indexOf('cd "$CHECKOUT"');
    const originCheck = setup.indexOf("git remote get-url origin");
    const exactOrigins = setup.indexOf(
      "https://github.com/eabnelson/pronto.git|git@github.com:eabnelson/pronto.git)",
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
      'PRONTO="$HOME/Library/Application Support/pronto/bin/pronto"\n   "$PRONTO" status',
    );
  });
});
