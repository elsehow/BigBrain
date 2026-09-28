import { afterEach, describe, expect, test } from "bun:test";
import { gmailTs, memoryCadence } from "../web/ui/src/lib/utils";
import {
  DEFAULT_CHOICE,
  labelFor,
  setChoice,
  skins,
  storedChoice,
  themeFor,
  watchSystemTheme,
  THEMES,
} from "../web/ui/src/lib/theme";

// gmailTs — the feed's Gmail-rule stamp. Dates are built with the LOCAL
// constructor so "same calendar day" holds in whatever timezone the test
// runs in; the locale is pinned to en-US for exact strings.
describe("gmailTs", () => {
  const now = new Date(2026, 6, 24, 12, 0, 0); // local Jul 24, noon
  test("same calendar day → just the time", () => {
    expect(gmailTs(new Date(2026, 6, 24, 13, 4).getTime(), now, "en-US")).toBe("1:04 PM");
    expect(gmailTs(new Date(2026, 6, 24, 8, 12).getTime(), now, "en-US")).toBe("8:12 AM");
  });
  test("an older day → just the date", () => {
    expect(gmailTs(new Date(2026, 6, 23, 19, 40).getTime(), now, "en-US")).toBe("Jul 23");
    expect(gmailTs(new Date(2026, 5, 2, 9, 0).getTime(), now, "en-US")).toBe("Jun 2");
  });
  test("exact UTC midnight is the date-only sentinel — shows that UTC date everywhere", () => {
    expect(gmailTs(Date.UTC(2026, 6, 8, 0, 0, 0), now, "en-US")).toBe("Jul 8");
  });
  test("no timestamp → empty", () => {
    expect(gmailTs(undefined, now, "en-US")).toBe("");
    expect(gmailTs(0, now, "en-US")).toBe("");
  });
});

// The palette decision: the person's own choice, else DEFAULT_CHOICE, which
// is the OS's preference. Ghostty is gone (it needed one specific terminal
// emulator and did nothing on the hosted app), so there is nothing left to
// rank against.
describe("themeFor", () => {
  test("no choice → the OS decides: dark desktop nurebairo, light desktop the bare default", () => {
    // for one day (2026-09-01) an unset record meant OG web blue on every
    // desktop; it is back to the OS's call, and the blue is a choice
    expect(DEFAULT_CHOICE).toBe("system");
    expect(themeFor(true)).toBe("dusk");
    expect(themeFor(false)).toBeNull();
  });

  test("following the system, spelled out, is the same answer", () => {
    expect(themeFor(true, "system")).toBe("dusk");
    expect(themeFor(false, "system")).toBeNull();
  });

  test("the picker leads with the two halves of the default: Light, then nurebairo", () => {
    expect(THEMES[0]).toBe("default");
    expect(THEMES[1]).toBe("dusk");
    expect(THEMES).toContain(themeFor(true)); // the dark half is a palette the picker offers
  });

  test("a choice outranks the OS, both ways", () => {
    expect(themeFor(true, "phosphor")).toBe("phosphor");
    expect(themeFor(false, "web")).toBe("web");
  });

  test("choosing the default NAMES itself — a swatch wears its palette inside an app wearing another", () => {
    // the one case where "the default" and "no attribute" must differ: an
    // absent attribute inherits whatever ancestor theme is in force
    expect(themeFor(true, "default")).toBe("default");
    expect(themeFor(false, "default")).toBe("default");
  });

  test("every palette the picker offers is one themeFor will hand back", () => {
    for (const t of THEMES) expect(themeFor(false, t)).toBe(t);
  });
});

// The choice is this machine's, and localStorage is where it lives. The
// failure that matters is a stored value that is no longer a palette (a
// renamed theme, a hand-edited key): it must read as "system", not paint the
// root with a data-theme no stylesheet answers.
describe("the stored choice", () => {
  const stubStorage = () => {
    const map = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => map.set(k, v),
      removeItem: (k: string) => map.delete(k),
    };
    return map;
  };
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    delete (globalThis as unknown as { document?: unknown }).document;
  });

  test("nothing stored → system", () => {
    stubStorage();
    expect(storedChoice()).toBe(DEFAULT_CHOICE);
    expect(storedChoice()).toBe("system");
  });

  test("no storage at all → system, not a throw", () => {
    // a private window, or a webview with site data off: the app still runs
    expect(storedChoice()).toBe("system");
  });

  test("a stored palette comes back; junk does not", () => {
    const map = stubStorage();
    map.set("bigbrain:theme", "web");
    expect(storedChoice()).toBe("web");
    map.set("bigbrain:theme", "ghostty");
    expect(storedChoice()).toBe("system");
  });

  test("removed palettes fall back to the system", () => {
    const map = stubStorage();
    for (const removed of ["ultraviolet", "tangerine", "hivis", "zenburn"]) {
      map.set("bigbrain:theme", removed);
      expect(storedChoice()).toBe("system");
    }
  });

  test("following the system is STORED, even though absence means it too", () => {
    // a written record is the person's decision, and it outlives whatever an
    // unset record comes to mean (it meant the blue for a day)
    const map = stubStorage();
    (globalThis as unknown as { document: unknown }).document = {
      documentElement: { setAttribute: () => {}, removeAttribute: () => {} },
    };
    setChoice("system");
    expect(map.get("bigbrain:theme")).toBe("system");
    expect(storedChoice()).toBe("system");
  });

  test("setChoice records a palette and paints it", () => {
    const map = stubStorage();
    const attrs = new Map<string, string>();
    (globalThis as unknown as { document: unknown }).document = {
      documentElement: {
        setAttribute: (k: string, v: string) => attrs.set(k, v),
        removeAttribute: (k: string) => attrs.delete(k),
      },
    };
    setChoice("phosphor");
    expect(map.get("bigbrain:theme")).toBe("phosphor");
    expect(attrs.get("data-theme")).toBe("phosphor"); // and it painted
    setChoice("default");
    expect(map.get("bigbrain:theme")).toBe("default");
    expect(attrs.get("data-theme")).toBe("default");
  });
});

// The wiring, against a hand-stubbed DOM. themeFor is the decision; this is
// the part that actually paints, and its bugs are the ones a user sees — a
// tab that stays light on a dark desktop, or one that ignores an appearance
// change mid-session. Bun has no DOM, and the globals this module touches are
// small enough to stand up by hand.
//
// Storage is stubbed EMPTY: this is the cold-start path, no record at all,
// and the OS is what decides.
describe("theme wiring: the root attribute follows the OS", () => {
  const stubDom = (systemDark: boolean) => {
    const attrs = new Map<string, string>();
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    };
    const listeners: Array<() => void> = [];
    const media = {
      matches: systemDark,
      addEventListener: (_e: string, fn: () => void) => listeners.push(fn),
    };
    (globalThis as unknown as { document: unknown }).document = {
      documentElement: {
        setAttribute: (k: string, v: string) => attrs.set(k, v),
        removeAttribute: (k: string) => attrs.delete(k),
      },
    };
    (globalThis as unknown as { window: unknown }).window = { matchMedia: () => media, addEventListener: () => {} };
    return {
      theme: () => attrs.get("data-theme"),
      /** The OS flipping appearance while the page is open. */
      flipSystem: (dark: boolean) => {
        media.matches = dark;
        for (const fn of listeners) fn();
      },
    };
  };

  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  test("a dark desktop paints dark, before the app mounts", () => {
    const dom = stubDom(true);
    watchSystemTheme();
    expect(dom.theme()).toBe("dusk");
  });

  test("a light desktop stays on the bare default palette", () => {
    const dom = stubDom(false);
    watchSystemTheme();
    expect(dom.theme()).toBeUndefined();
  });

  test("an OS switch mid-session repaints, both ways", () => {
    const dom = stubDom(false);
    watchSystemTheme();
    dom.flipSystem(true);
    expect(dom.theme()).toBe("dusk");
    dom.flipSystem(false);
    expect(dom.theme()).toBeUndefined();
  });

  test("no matchMedia at all is a light answer, not a crash", () => {
    // Old webviews, and any DOM-less environment that still imports this.
    // No localStorage either: no record to read and no OS to ask, and it
    // lands on the bare default rather than throwing.
    const attrs = new Map<string, string>();
    (globalThis as unknown as { document: unknown }).document = {
      documentElement: {
        setAttribute: (k: string, v: string) => attrs.set(k, v),
        removeAttribute: (k: string) => attrs.delete(k),
      },
    };
    // Old webviews have no matchMedia; every window has addEventListener.
    (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {} };
    expect(() => watchSystemTheme()).not.toThrow();
    expect(attrs.get("data-theme")).toBeUndefined();
  });
});

// Skins: this machine's own palettes, served by the engine as CSS
// (lib/themes.ts) and injected here. What matters on this side: a chosen
// skin paints on the FIRST frame from the cache, before the engine answers;
// the engine's answer replaces the cache; a skin the engine no longer has
// reads as "system" while its record stays; and a 404 (no desktop door)
// drops the cache rather than keeping a palette nothing here can define.
describe("skins: this machine's own palettes", () => {
  const GRUVBOX = { id: "skin-gruvbox" as const, label: "Gruvbox", scheme: "dark" as const, file: "gruvbox.yaml" };
  const CSS = '[data-theme="skin-gruvbox"] {\n  --bg: #282828;\n  color-scheme: dark;\n}';
  const realFetch = globalThis.fetch;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  const stub = (opts: { cached?: boolean; choice?: string; answer: null | object | "down" }) => {
    const store = new Map<string, string>();
    if (opts.cached) store.set("bigbrain:skins", JSON.stringify({ skins: [GRUVBOX], css: CSS }));
    if (opts.choice) store.set("bigbrain:theme", opts.choice);
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    };
    const attrs = new Map<string, string>();
    const head: { id: string; textContent: string }[] = [];
    (globalThis as unknown as { document: unknown }).document = {
      documentElement: {
        setAttribute: (k: string, v: string) => attrs.set(k, v),
        removeAttribute: (k: string) => attrs.delete(k),
      },
      head: { appendChild: (el: { id: string; textContent: string }) => head.push(el) },
      createElement: () => ({ id: "", textContent: "" }),
      getElementById: (id: string) => head.find((e) => e.id === id) ?? null,
    };
    (globalThis as unknown as { window: unknown }).window = {
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      addEventListener: () => {},
    };
    globalThis.fetch = (async (url) => {
      if (url === "/api/vault") return Response.json({});
      if (opts.answer === "down") throw new Error("ECONNREFUSED");
      return Response.json(opts.answer, { status: opts.answer === null ? 404 : 200 });
    }) as unknown as typeof fetch;
    return {
      theme: () => attrs.get("data-theme"),
      css: () => head.find((e) => e.id === "bigbrain-skins")?.textContent,
      store,
    };
  };
  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    globalThis.fetch = realFetch;
  });

  test("a cached skin paints on the first frame, before the engine answers — or when it never does", async () => {
    const dom = stub({ cached: true, choice: "skin-gruvbox", answer: "down" });
    watchSystemTheme();
    expect(dom.theme()).toBe("skin-gruvbox");
    expect(dom.css()).toBe(CSS);
    expect(labelFor("skin-gruvbox")).toBe("Gruvbox");
    await tick();
    expect(dom.theme()).toBe("skin-gruvbox"); // the engine was down: the cache stands
  });

  test("the engine's answer is adopted: css on the page, the skin known, the choice honoured", async () => {
    const dom = stub({ choice: "skin-gruvbox", answer: { dir: "/x", skins: [GRUVBOX], css: CSS, errors: [] } });
    watchSystemTheme();
    expect(dom.theme()).toBeUndefined(); // not known yet: the record reads as system
    expect(dom.css()).toBeUndefined(); // and no empty <style> for nothing
    await tick();
    expect(dom.theme()).toBe("skin-gruvbox");
    expect(dom.css()).toBe(CSS);
    expect(skins()).toEqual([GRUVBOX]);
    expect(JSON.parse(dom.store.get("bigbrain:skins")!)).toEqual({ skins: [GRUVBOX], css: CSS });
  });

  test("a chosen skin the engine no longer has reads as system; the record stays for its return", async () => {
    const dom = stub({ cached: true, choice: "skin-gruvbox", answer: { dir: "/x", skins: [], css: "", errors: [] } });
    watchSystemTheme();
    expect(dom.theme()).toBe("skin-gruvbox");
    await tick();
    expect(dom.theme()).toBeUndefined();
    expect(dom.css()).toBe("");
    expect(dom.store.get("bigbrain:theme")).toBe("skin-gruvbox");
    expect(storedChoice()).toBe("system");
  });

  test("no door here (404) drops the cache", async () => {
    const dom = stub({ cached: true, answer: null });
    watchSystemTheme();
    expect(skins()).toEqual([GRUVBOX]);
    await tick();
    expect(skins()).toEqual([]);
    expect(JSON.parse(dom.store.get("bigbrain:skins")!)).toEqual({ skins: [], css: "" });
  });
});

// The memory note under settings › agents: when the sweep runs, from the
// engine's memory.interval (ms) — not a constant that was wrong for any
// vault off the 1d default.
describe("memoryCadence: when the sweep runs, from the vault's own interval", () => {
  test("whole days, whole hours, else minutes", () => {
    expect(memoryCadence(86_400_000)).toBe("Runs once per day.");
    expect(memoryCadence(2 * 86_400_000)).toBe("Runs every 2 days.");
    expect(memoryCadence(3_600_000)).toBe("Runs every hour.");
    expect(memoryCadence(6 * 3_600_000)).toBe("Runs every 6 hours.");
    expect(memoryCadence(90 * 60_000)).toBe("Runs every 90 minutes.");
    expect(memoryCadence(60_000)).toBe("Runs every minute.");
  });
  test("no number (an older engine), or a bad one, reads as the default", () => {
    expect(memoryCadence(undefined)).toBe("Runs once per day.");
    expect(memoryCadence(0)).toBe("Runs once per day.");
    expect(memoryCadence(Number.NaN)).toBe("Runs once per day.");
  });
});
