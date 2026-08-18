import { describe, expect, test } from "bun:test";

const siteRoot = new URL("../../site/", import.meta.url);
const setupPrompt = "Help me set up s4imsg: https://eabnelson.github.io/s4imsg/setup.md";

async function read(name: string): Promise<string> {
  return Bun.file(new URL(name, siteRoot)).text();
}

type FakeEvent = {
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
}

class FakeElement extends FakeEventTarget {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style = new FakeStyle();
  className = "";
  href = "";
  offsetWidth = 220;
  parent: FakeElement | undefined;
  textContent = "";
  value = "";

  get childElementCount(): number {
    return this.children.length;
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

class FakeWindow {
  readonly assignedLocations: string[] = [];
  readonly motionPreference: FakeMediaQueryList;
  readonly timers = new Map<number, () => void>();
  innerWidth = 1200;
  private nextTimer = 1;

  readonly location = {
    assign: (href: string) => this.assignedLocations.push(href),
  };

  constructor(reducedMotion = false) {
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
  reducedMotion?: boolean;
} = {}): Promise<LandingPageHarness> {
  const html = await read("index.html");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("landing page inline script not found");

  const stream = new FakeElement();
  const copyButton = new FakeElement();
  copyButton.href = "https://example.test/setup.md";
  copyButton.textContent = "Help me set up s4imsg";
  const document = new FakeDocument(stream, copyButton);
  const window = new FakeWindow(options.reducedMotion);
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
  test("keeps the hero minimal and points to the setup prompt", async () => {
    const html = await read("index.html");

    expect(html).toContain(">Pick any tag</h1>");
    expect(html).toContain("Message Codex or Claude from any conversation");
    expect(html).toContain('id="copy-prompt"');
    expect(html).toContain('href="./setup.md"');
    expect(html).toContain(">Help me set up s4imsg</a>");
    expect(html).toContain("https://eabnelson.github.io/s4imsg/setup.md");
    expect(html).toContain("overflow-x: hidden");
    expect(html).toContain("overflow-y: auto");
    expect(html).not.toContain('class="mark"');
  });

  test("streams varied tail-free message bubbles behind the hero", async () => {
    const html = await read("index.html");

    expect(html).toContain('data-bubble-stream');
    expect(html).toContain("@codex");
    expect(html).toContain("@claude");
    expect(html).toContain("@plan");
    expect(html).toContain("--rotation");
    expect(html).not.toContain("setInterval");
    expect(html).not.toContain(".bubble.incoming::after");
    expect(html).not.toContain(".bubble.outgoing::after");
  });

  test("copies the exact setup prompt and shows its copied state", async () => {
    const harness = await createLandingPageHarness();

    await harness.copyButton.dispatch("click");

    expect(harness.copiedText).toEqual([setupPrompt]);
    expect(harness.copyButton.textContent).toBe("Copied prompt");
    expect(harness.copyButton.dataset.copied).toBe("true");
    expect(harness.window.assignedLocations).toEqual([]);
  });

  test("opens the setup guide and clears copied state when clipboard access fails", async () => {
    const harness = await createLandingPageHarness({ clipboardRejects: true });
    harness.copyButton.dataset.copied = "true";

    await harness.copyButton.dispatch("click");

    expect(harness.copyButton.dataset.copied).toBeUndefined();
    expect(harness.copyButton.textContent).toBe("Opening setup guide…");
    expect(harness.window.assignedLocations).toEqual([harness.copyButton.href]);
  });

  test("runs a bounded animated stream and pauses and resumes while hidden", async () => {
    const harness = await createLandingPageHarness();

    expect(harness.stream.childElementCount).toBe(12);
    expect(harness.window.timers.size).toBe(1);

    while (harness.stream.childElementCount < 18) harness.window.runNextTimer();
    expect(harness.stream.childElementCount).toBe(18);
    expect(harness.window.timers.size).toBe(0);

    const finishedBubble = harness.stream.children[0];
    if (!finishedBubble) throw new Error("expected an animated bubble");
    await finishedBubble.dispatch("animationend");
    expect(harness.stream.childElementCount).toBe(17);
    expect(harness.window.timers.size).toBe(1);

    harness.document.hidden = true;
    await harness.document.dispatch("visibilitychange");
    expect(harness.window.timers.size).toBe(0);

    harness.document.hidden = false;
    await harness.document.dispatch("visibilitychange");
    expect(harness.window.timers.size).toBe(1);
    harness.window.runNextTimer();
    expect(harness.stream.childElementCount).toBe(18);
    expect(harness.window.timers.size).toBe(0);
  });

  test("responds to live reduced-motion changes", async () => {
    const harness = await createLandingPageHarness();

    await harness.motionPreference.change(true);
    expect(harness.stream.childElementCount).toBe(8);
    expect(harness.window.timers.size).toBe(0);
    expect(harness.stream.children.every((bubble) => bubble.dataset.static === "true")).toBe(true);

    await harness.motionPreference.change(false);
    expect(harness.stream.childElementCount).toBe(12);
    expect(harness.window.timers.size).toBe(1);
    expect(harness.stream.children.every((bubble) => bubble.dataset.static === undefined)).toBe(true);
    expect(
      harness.stream.children.every(
        (bubble) =>
          bubble.style.properties.has("--duration") &&
          bubble.style.properties.get("--delay")?.startsWith("-") === true,
      ),
    ).toBe(true);
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
