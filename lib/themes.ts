/** Three-color viewer skins stored beside this machine's preferences.
 * Required: name, colors.bg, colors.text, colors.activity. The viewer
 * derives all other tokens. Legacy accents use their first color; old
 * neutral overrides are ignored. Values are validated before CSS output. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { osOpen } from "./diagnostics";
import { configDir } from "./engine";
import { json, type Route } from "./httpx";

/** Where the skins live: `~/.config/bigbrain/themes/`. */
export const themesDir = (): string => join(configDir(), "themes");

export interface Skin {
  /** The data-theme value: `skin-<file stem>`. The prefix keeps a file
   * called light.yaml from shadowing the built-in. */
  id: string;
  label: string;
  /** What the UA paints (scrollbars, form controls) — named in the file, or
   * read off the background's luminance. */
  scheme: "light" | "dark";
  /** Every custom property the palette sets, `--bg`, `--fg`, `--activity`, and
   * `--font-app` / `--font-mono` when the file names fonts. */
  vars: Record<string, string>;
  file: string;
}

export interface SkinError {
  file: string;
  error: string;
}

export interface SkinsReport {
  dir: string;
  skins: Skin[];
  /** One stylesheet for all of them — what the viewer injects. */
  css: string;
  errors: SkinError[];
}

// ── values ───────────────────────────────────────────────────────────────────

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([\w\s.,%/+-]*\)$/i;
const NAMED = /^[a-z]{3,24}$/i;
const FONT = /^[\w\s,"'-]+$/;

/** A CSS colour we will put in a stylesheet: hex, a colour function whose
 * argument list is numbers and separators only, or a bare name. Nothing
 * that could close a declaration, a block or a comment. */
export function isColor(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  return HEX.test(s) || FUNC.test(s) || NAMED.test(s);
}

/** A font-family list: names, quotes, commas. */
export function isFontList(v: unknown): v is string {
  return typeof v === "string" && FONT.test(v.trim()) && v.trim().length > 0;
}

/** Relative luminance of a hex colour (sRGB, WCAG), or null when the value
 * is not hex — the scheme default is a guess, and a guess only from what
 * can be read. */
export function hexLuminance(v: string): number | null {
  const m = HEX.exec(v.trim());
  if (!m) return null;
  let h = v.trim().slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const ch = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

/** The file stem as an id: lower-case, runs of anything else collapsed to
 * one dash. Empty when nothing survives. */
export function skinId(stem: string): string {
  const s = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s ? `skin-${s}` : "";
}

// ── one file ─────────────────────────────────────────────────────────────────

export type Parsed = { ok: true; skin: Skin } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One YAML document → one skin, or the reason it is not one. `file` is
 * the basename, for the id and the error. */
export function parseSkin(text: string, file: string): Parsed {
  const id = skinId(file.replace(/\.ya?ml$/i, ""));
  if (!id) return { ok: false, error: "the file name has no letters or digits to make an id from" };
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { ok: false, error: `not YAML: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
  }
  if (!isRecord(doc)) return { ok: false, error: "the file is not a mapping (expected `name:` and `colors:`)" };
  const label = typeof doc["name"] === "string" && doc["name"].trim() ? doc["name"].trim() : null;
  if (!label) return { ok: false, error: "`name:` is missing" };
  const colors = doc["colors"];
  if (!isRecord(colors)) return { ok: false, error: "`colors:` is missing" };

  const vars: Record<string, string> = {};
  const legacy = colors["accents"];
  const activity = colors["activity"] ?? (Array.isArray(legacy) ? legacy[0] : undefined);
  for (const [key, prop, value] of [
    ["bg", "--bg", colors["bg"]], ["text", "--fg", colors["text"]], ["activity", "--activity", activity],
  ] as const) {
    if (value === undefined || value === null) return { ok: false, error: `colors.${key} is required` };
    if (!isColor(value)) return { ok: false, error: `colors.${key} is not a colour: ${JSON.stringify(value)}` };
    vars[prop] = value.trim();
  }

  const fonts = doc["fonts"];
  if (isRecord(fonts)) {
    for (const [key, prop] of [["app", "--font-app"], ["mono", "--font-mono"]] as const) {
      const v = fonts[key];
      if (v === undefined || v === null) continue;
      if (!isFontList(v)) return { ok: false, error: `fonts.${key} is not a font list: ${JSON.stringify(v)}` };
      vars[prop] = v.trim();
    }
  }

  let scheme: Skin["scheme"];
  const s = doc["scheme"];
  if (s === "light" || s === "dark") scheme = s;
  else if (s !== undefined && s !== null) return { ok: false, error: `scheme must be "light" or "dark", got ${JSON.stringify(s)}` };
  else {
    const l = hexLuminance(vars["--bg"]!);
    scheme = l !== null && l < 0.3 ? "dark" : "light";
  }
  return { ok: true, skin: { id, label, scheme, vars, file } };
}

/** One three-color rule per skin; tokens.css derives the semantic aliases. */
export function skinsCss(skins: readonly Skin[]): string {
  return skins
    .map((s) => {
      const decls = Object.entries(s.vars).map(([k, v]) => `  ${k}: ${v};`);
      decls.push(`  color-scheme: ${s.scheme};`);
      return `[data-theme="${s.id}"] {\n${decls.join("\n")}\n}`;
    })
    .join("\n\n");
}

// ── the folder ───────────────────────────────────────────────────────────────

/** Every `.yaml`/`.yml` in the folder, by name. A folder that is not there
 * is an empty report, not an error: most machines never make one. */
export function readSkins(dir: string = themesDir()): SkinsReport {
  const skins: Skin[] = [];
  const errors: SkinError[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f) && !f.startsWith(".")).sort();
  } catch {
    /* no folder yet */
  }
  const seen = new Map<string, string>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch (e) {
      errors.push({ file, error: `cannot read: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const r = parseSkin(text, file);
    if (!r.ok) {
      errors.push({ file, error: r.error });
      continue;
    }
    const other = seen.get(r.skin.id);
    if (other) {
      errors.push({ file, error: `same id as ${other} — rename one of them` });
      continue;
    }
    seen.set(r.skin.id, file);
    skins.push(r.skin);
  }
  return { dir, skins, css: skinsCss(skins), errors };
}

/** A complete three-color example, ready to copy. */
export const EXAMPLE_FILE = "solarized-light.yaml";
export const EXAMPLE_SKIN = `# A BigBrain skin. Copy under a new name and edit these three colors.
# Required: name, colors.bg, colors.text, colors.activity.
# Muted text, surfaces and borders derive from the background and foreground.
# Values: hex, rgb()/hsl()/oklch(), or a CSS color name.
name: Solarized Light
scheme: light
colors:
  bg: "#fdf6e3"
  text: "#586e75"
  activity: "#dc322f"
# Optional:
# fonts:
#   app: "Hanken Grotesk, system-ui, sans-serif"
#   mono: "ui-monospace, Menlo, monospace"
`;

/** Write the example into the folder (creating it) unless a file of that
 * name is already there — never over a person's edits. */
export function writeExample(dir: string = themesDir()): { ok: boolean; path: string; existed: boolean } {
  const path = join(dir, EXAMPLE_FILE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(path)) return { ok: true, path, existed: true };
  writeFileSync(path, EXAMPLE_SKIN);
  return { ok: true, path, existed: false };
}

/** The three doors. `dir` is resolved per request, not at mount: the
 * config dir is a function for a reason (lib/engine.ts — install moves it
 * mid-process), and the tests hand in a folder of their own. */
/** `reveal` is what shows the folder — the OS's file browser in the app. A
 * test passes its own: the real one runs `open` and every `bun test` on a
 * Mac put a Finder window on Nick's screen (2026-09-03: "releases always
 * open the theme folder"). */
export function themesRoutes(fixed?: string, reveal: (dir: string) => boolean = osOpen): Route[] {
  const dir = (): string => fixed ?? themesDir();
  return [
    { method: "GET", path: "/api/themes", handler: ({ res }) => json(res, 200, readSkins(dir())) },
    {
      method: "POST",
      path: "/api/themes/reveal",
      handler: ({ res }) => {
        // the folder is made on the way: an empty folder that opens beats a
        // path that does not exist
        const d = dir();
        mkdirSync(d, { recursive: true, mode: 0o700 });
        json(res, 200, { ok: reveal(d), path: d });
      },
    },
    { method: "POST", path: "/api/themes/example", handler: ({ res }) => json(res, 200, writeExample(dir())) },
  ];
}
