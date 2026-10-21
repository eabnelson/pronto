import { expect, test } from "bun:test";

type BrowserEvent = { matches?: boolean; preventDefault(): void };

class EventTarget {
  private readonly listeners = new Map<string, (event: BrowserEvent) => unknown>();

  addEventListener(type: string, callback: (event: BrowserEvent) => unknown): void {
    this.listeners.set(type, callback);
  }

  async emit(type: string, event: BrowserEvent = { preventDefault() {} }): Promise<void> {
    await this.listeners.get(type)?.(event);
  }
}

class Element extends EventTarget {
  readonly children: Element[] = [];
  readonly dataset: Record<string, string> = {};
  readonly properties = new Map<string, string>();
  readonly style = {
    setProperty: (name: string, value: string) => this.properties.set(name, value),
    getPropertyValue: (name: string) => this.properties.get(name) ?? "",
  };
  textContent = "";
  href = "";
  offsetWidth = 220;
  animations = 0;
  canceled = 0;

  append(child: Element): void { this.children.push(child); }
  replaceChildren(): void { this.children.length = 0; }
  animate(): { cancel(): void } {
    this.animations += 1;
    return { cancel: () => { this.canceled += 1; } };
  }
}

async function page(clipboardRejects = false) {
  const html = await Bun.file(new URL("../../site/index.html", import.meta.url)).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const link = html.match(/<a\b[^>]*\bid="copy-prompt"[^>]*>/)?.[0];
  if (!script || !link) throw new Error("Setup link or page script is missing");
  const button = new Element();
  button.href = link.match(/\bhref="([^"]+)"/)?.[1] ?? "";
  if (!button.href) throw new Error("Setup link has no destination");
  button.textContent = "Help me get set up";
  const stream = new Element();
  const motion = Object.assign(new EventTarget(), { matches: false });
  const copied: string[] = [];
  const navigations: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const window = Object.assign(new EventTarget(), {
    innerWidth: 1200,
    innerHeight: 844,
    matchMedia: () => motion,
    location: { assign: (url: string) => navigations.push(url) },
    setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const document = {
    querySelector: (selector: string) => selector === "#copy-prompt" ? button : stream,
    createElement: () => new Element(),
  };
  const navigator = { clipboard: { writeText: async (text: string) => {
    if (clipboardRejects) throw new Error("Clipboard unavailable");
    copied.push(text);
  } } };
  Function("document", "window", "navigator", script)(document, window, navigator);
  return { button, stream, motion, copied, navigations, timers };
}

test("the setup button copies a usable handoff and clears its copied state", async () => {
  const h = await page();
  await h.button.emit("click");
  expect(h.copied).toHaveLength(1);
  expect(h.copied[0]).toContain(h.button.href);
  expect(h.copied[0]).toContain("Pronto");
  expect(h.button.dataset.copied).toBe("true");
  for (const callback of h.timers.values()) callback();
  expect(h.button.dataset.copied).toBeUndefined();
});

test("clipboard failure opens the setup guide without claiming the prompt was copied", async () => {
  const h = await page(true);
  await h.button.emit("click");
  expect(h.copied).toEqual([]);
  expect(h.navigations).toEqual([h.button.href]);
  expect(h.button.dataset.copied).toBeUndefined();
});

test("reduced motion stops animated bubbles and keeps visible examples", async () => {
  const h = await page();
  const animated = [...h.stream.children];
  expect(animated.length).toBeGreaterThan(0);
  expect(animated.every((bubble) => bubble.animations > 0)).toBe(true);
  await h.motion.emit("change", { matches: true, preventDefault() {} });
  expect(animated.every((bubble) => bubble.canceled > 0)).toBe(true);
  expect(h.stream.children.length).toBeGreaterThan(0);
  expect(h.stream.children.every((bubble) => bubble.dataset.static === "true" && bubble.animations === 0)).toBe(true);
});
