import { normalizeSkinsCss } from "../web/ui/src/lib/skins";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { dispatch, type Route } from "../lib/httpx";
import {
  EXAMPLE_FILE,
  EXAMPLE_SKIN,
  hexLuminance,
  isColor,
  isFontList,
  parseSkin,
  readSkins,
  skinId,
  skinsCss,
  themesRoutes,
  writeExample,
} from "../lib/themes";

// skins: a person's own palettes, one YAML each in ~/.config/bigbrain/themes/,
// served to the viewer as the CSS it injects before it paints.
const tmp = (): string => mkdtempSync(join(tmpdir(), "bb-skins-"));

const MINIMAL = `name: Bare
colors:
  bg: "#101010"
  text: "#eeeeee"
  activity: red
`;

describe("values", () => {
  test("a colour is hex, a colour function of numbers, or a name — never a declaration", () => {
    for (const ok of ["#fff", "#ffff", "#fdf6e3", "#fdf6e3cc", "rgb(1,2,3)", "rgba(0, 0, 0, .2)", "hsl(200 50% 40%)", "oklch(0.7 0.1 200)", "color(display-p3 1 0 0)", "rebeccapurple", " #fff "])
      expect(isColor(ok)).toBe(true);
    for (const bad of ["#ggg", "#12345", "red; --bg: blue", "url(x)", "rgb(1,2,3); }", "var(--bg)", "", 12, null, "a b"])
      expect(isColor(bad)).toBe(false);
  });
  test("a font list is names, quotes and commas", () => {
    expect(isFontList('"Hanken Grotesk", system-ui, sans-serif')).toBe(true);
    expect(isFontList("Menlo; color: red")).toBe(false);
    expect(isFontList("")).toBe(false);
  });
  test("luminance: white 1, black 0, short hex expands, not-hex is null", () => {
    expect(hexLuminance("#fff")).toBeCloseTo(1, 5);
    expect(hexLuminance("#000000")).toBe(0);
    expect(hexLuminance("#3f3f3f")).toBeLessThan(0.3);
    expect(hexLuminance("rgb(1,2,3)")).toBeNull();
  });
  test("the id is the stem, prefixed, lower-cased, dashed", () => {
    expect(skinId("Solarized Light")).toBe("skin-solarized-light");
    expect(skinId("__My.Theme_2__")).toBe("skin-my-theme-2");
    expect(skinId("default")).toBe("skin-default"); // never shadows the built-in
    expect(skinId("---")).toBe("");
  });
});

describe("parseSkin", () => {
  test("the shipped example parses, three colors, scheme as written", () => {
    const r = parseSkin(EXAMPLE_SKIN, EXAMPLE_FILE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skin.id).toBe("skin-solarized-light");
    expect(r.skin.label).toBe("Solarized Light");
    expect(r.skin.scheme).toBe("light");
    expect(r.skin.vars["--bg"]).toBe("#fdf6e3");
    expect(r.skin.vars["--fg"]).toBe("#586e75");
    expect(r.skin.vars["--activity"]).toBe("#dc322f");
    expect(Object.keys(r.skin.vars)).toHaveLength(3);
    expect(r.skin.vars["--font-app"]).toBeUndefined(); // the fonts block is commented out
  });

  test("a minimal file derives the rest and reads dark off the background", () => {
    const r = parseSkin(MINIMAL, "bare.yaml");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.skin.vars;
    expect(r.skin.scheme).toBe("dark");
    expect(v).toEqual({ "--bg": "#101010", "--fg": "#eeeeee", "--activity": "red" });
  });

  test("legacy palettes reduce to three colors, explicit activity wins", () => {
    const old = MINIMAL.replace("activity: red", 'accents: [blue, green, red]\n  surface: "#123456"');
    const r = parseSkin(old, "old.yaml");
    expect(r.ok && r.skin.vars).toEqual({ "--bg": "#101010", "--fg": "#eeeeee", "--activity": "blue" });
    const explicit = parseSkin(old + "  activity: yellow\n", "old.yaml");
    expect(explicit.ok && explicit.skin.vars["--activity"]).toBe("yellow");
  });

  test("fonts ride along when named", () => {
    const r = parseSkin(MINIMAL + 'fonts:\n  app: "Inter, sans-serif"\n', "f.yaml");
    expect(r.ok && r.skin.vars["--font-app"]).toBe("Inter, sans-serif");
    expect(r.ok && r.skin.vars["--font-mono"]).toBeUndefined();
  });

  test("scheme: named wins over the guess; anything else is refused", () => {
    expect(parseSkin(MINIMAL + "scheme: light\n", "s.yaml")).toMatchObject({ ok: true, skin: { scheme: "light" } });
    expect(parseSkin(MINIMAL + "scheme: auto\n", "s.yaml")).toMatchObject({ ok: false, error: 'scheme must be "light" or "dark", got "auto"' });
  });

  test("each refusal names what is wrong", () => {
    const err = (text: string, file = "x.yaml"): string => {
      const r = parseSkin(text, file);
      return r.ok ? "(ok)" : r.error;
    };
    expect(err("name: [\n")).toStartWith("not YAML:");
    expect(err("- a\n- b\n")).toBe("the file is not a mapping (expected `name:` and `colors:`)");
    expect(err("colors: {}\n")).toBe("`name:` is missing");
    expect(err("name: X\n")).toBe("`colors:` is missing");
    expect(err("name: X\ncolors:\n  text: '#fff'\n")).toBe("colors.bg is required");
    expect(err("name: X\ncolors:\n  bg: '#fff'\n  text: 'red; }'\n")).toBe('colors.text is not a colour: "red; }"');
    expect(err("name: X\ncolors:\n  bg: '#fff'\n  text: '#000'\n  accents: []\n")).toBe("colors.activity is required");
    expect(err("name: X\ncolors:\n  bg: '#fff'\n  text: '#000'\n  activity: 'url(x)'\n")).toBe('colors.activity is not a colour: "url(x)"');
    expect(err(MINIMAL + "fonts:\n  mono: 'Menlo; x'\n")).toBe('fonts.mono is not a font list: "Menlo; x"');
    expect(err(MINIMAL, "___.yaml")).toBe("the file name has no letters or digits to make an id from");
  });

  test("unknown keys are ignored (§5)", () => {
    const r = parseSkin(MINIMAL + "author: me\ncolors2: {}\n", "x.yaml");
    expect(r.ok).toBe(true);
  });
});

describe("skinsCss", () => {
  test("one three-color block per skin", () => {
    const r = parseSkin(MINIMAL, "bare.yaml");
    if (!r.ok) throw new Error(r.error);
    const css = skinsCss([r.skin]);
    expect(css).toStartWith('[data-theme="skin-bare"] {\n  --bg: #101010;\n  --fg: #eeeeee;');
    expect(css).toContain("  color-scheme: dark;\n}");
    expect(skinsCss([])).toBe("");
  });
});

describe("readSkins", () => {
  test("no folder is an empty report; then each yaml is a skin or a named error, by name", () => {
    const dir = join(tmp(), "themes");
    expect(readSkins(dir)).toEqual({ dir, skins: [], css: "", errors: [] });
    mkdirSync(dir);
    writeFileSync(join(dir, "b-bare.yml"), MINIMAL);
    writeFileSync(join(dir, "a-broken.yaml"), "name: [\n");
    writeFileSync(join(dir, "notes.txt"), "not a skin");
    writeFileSync(join(dir, ".hidden.yaml"), MINIMAL);
    writeFileSync(join(dir, EXAMPLE_FILE), EXAMPLE_SKIN);
    const r = readSkins(dir);
    expect(r.skins.map((s) => s.id)).toEqual(["skin-b-bare", "skin-solarized-light"]);
    expect(r.errors).toEqual([{ file: "a-broken.yaml", error: expect.stringMatching(/^not YAML:/) }]);
    expect(r.css).toContain('[data-theme="skin-solarized-light"]');
  });

  test("two files with one id: the second is an error naming the first", () => {
    const dir = tmp();
    writeFileSync(join(dir, "My Skin.yaml"), MINIMAL);
    writeFileSync(join(dir, "my-skin.yml"), MINIMAL);
    const r = readSkins(dir);
    expect(r.skins).toHaveLength(1);
    expect(r.errors).toEqual([{ file: "my-skin.yml", error: "same id as My Skin.yaml — rename one of them" }]);
  });
});

describe("writeExample", () => {
  test("makes the folder, writes once, never over an edit", () => {
    const dir = join(tmp(), "themes");
    const first = writeExample(dir);
    expect(first).toEqual({ ok: true, path: join(dir, EXAMPLE_FILE), existed: false });
    writeFileSync(first.path, "name: Mine\n");
    expect(writeExample(dir).existed).toBe(true);
    expect(readFileSync(first.path, "utf8")).toBe("name: Mine\n");
  });
});

// the routes, dispatched as web/server.ts would (test/diagnostics.test.ts's twin)
function call(routes: Route[], method: string, path: string): Promise<{ code: number; body: string }> {
  return new Promise((resolve) => {
    const req = Object.assign(new PassThrough(), { method, url: path, headers: { host: "127.0.0.1" } });
    let code = 0;
    let body = "";
    const res = {
      writeHead: (c: number) => { code = c; },
      setHeader() {},
      write: (b: string) => { body += b; },
      end: (b?: string) => { body += b ?? ""; resolve({ code, body }); },
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    dispatch(routes, req as any, res as any);
    req.end();
  });
}

describe("themesRoutes", () => {
  test("GET is the report; example writes the file; reveal makes the folder and names it", async () => {
    const dir = join(tmp(), "themes");
    // the opener is ours: the real one is `open`, which put a Finder window
    // on the screen every time this suite ran on a Mac
    const opened: string[] = [];
    const routes = themesRoutes(dir, (d) => { opened.push(d); return true; });
    expect(JSON.parse((await call(routes, "GET", "/api/themes")).body)).toEqual({ dir, skins: [], css: "", errors: [] });
    const ex = JSON.parse((await call(routes, "POST", "/api/themes/example")).body) as { existed: boolean };
    expect(ex.existed).toBe(false);
    const after = JSON.parse((await call(routes, "GET", "/api/themes")).body) as { skins: { id: string }[] };
    expect(after.skins.map((s) => s.id)).toEqual(["skin-solarized-light"]);
    const rv = JSON.parse((await call(routes, "POST", "/api/themes/reveal")).body) as { ok: boolean; path: string };
    expect(rv).toEqual({ ok: true, path: dir });
    expect(opened).toEqual([dir]);
  });
});

test("cached legacy CSS loses extra hues before its first paint", () => {
  const css = normalizeSkinsCss('[data-theme="skin-old"] { --bg: white; --text: black; --surface: pink; --accent-1: red; --accent-2: green; color-scheme: light; }');
  expect(css).toContain("--fg: black;");
  expect(css).toContain("--activity: red;");
  expect(css).not.toContain("pink");
  expect(css).not.toContain("green");
  expect(normalizeSkinsCss(css)).toBe(css);
});
