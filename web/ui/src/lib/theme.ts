// Nine three-color palettes, plus this machine's YAML skins. The picker leads
// with two light/dark pairs that follow the OS, Ink and Kind of Blue, then
// offers five palettes on their own. Stored ids outlive renames; the picker's
// names live in THEME_LABEL and PAIRS.
import { normalizeSkinsCss, fetchSkins, type Skin, type SkinsReport } from "./skins";
import { syncWindowBackground } from "./native";

/** The palettes the picker offers one by one, after the pairs. */
export const THEMES = ["web", "somethings-gotta-give", "moegiiro", "adzukiiro", "asagiiro"] as const;

/** Every built-in palette tokens.css paints: the pairs' halves, then the
 * singles. A half is offered only through its pair, but a record that names
 * one (Ink's halves were once offered alone) still paints it. */
export const PALETTES = ["default", "dusk", "kind-of-blue-light", "kind-of-blue-dark", ...THEMES] as const;
export type BuiltIn = (typeof PALETTES)[number];

/** A palette: one of the built-ins, or a skin of this machine's. */
export type Theme = BuiltIn | Skin["id"];

/** Light/dark pairs that follow the OS, in picker order. Ink keeps the id
 * "system", which every record that followed the OS already holds. */
export const PAIRS = {
  system: { label: "Ink", light: "default", dark: "dusk" },
  "kind-of-blue": { label: "Kind of Blue", light: "kind-of-blue-light", dark: "kind-of-blue-dark" },
} as const satisfies Record<string, { label: string; light: BuiltIn; dark: BuiltIn }>;
export type Pair = keyof typeof PAIRS;
export const PAIR_IDS = Object.keys(PAIRS) as Pair[];

/** What a person can choose: a palette, or a pair that follows the OS. */
export type ThemeChoice = Theme | Pair;

/** What an unset record means: Ink. Light desktops get its light half, which
 * is what tokens.css's bare :root paints — so index.html carries no
 * attribute, and a light first frame is already right; dark desktops get its
 * dark half, painted by main.ts before the mount. */
export const DEFAULT_CHOICE: ThemeChoice = "system";

/** How each built-in reads in the picker. A skin's label is its file's
 * `name:` (labelFor); a pair's is in PAIRS. */
export const THEME_LABEL: Record<BuiltIn, string> = {
  default: "Ink, light",
  dusk: "Ink, dark",
  "kind-of-blue-light": "Kind of Blue, light",
  "kind-of-blue-dark": "Kind of Blue, dark",
  web: "OG web blue",
  "somethings-gotta-give": "Something's Gotta Give",
  moegiiro: "Spring",
  adzukiiro: "Fall",
  asagiiro: "Winter",
};

const KEY = "bigbrain:theme";
const SKINS_KEY = "bigbrain:skins";
const STYLE_ID = "bigbrain-skins";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The skins this page knows: the engine's last answer, kept in localStorage
 * so a relaunch paints a chosen skin on its FIRST frame rather than after
 * the fetch — the same reason the choice is read before the mount. */
interface SkinsCache {
  skins: Skin[];
  css: string;
}
const NONE: SkinsCache = { skins: [], css: "" };

function readCache(): SkinsCache {
  try {
    const v = JSON.parse(localStorage.getItem(SKINS_KEY) ?? "null") as Partial<SkinsCache> | null;
    if (v && Array.isArray(v.skins) && typeof v.css === "string") return { skins: v.skins, css: v.css };
  } catch {
    /* no storage, or not ours */
  }
  return NONE;
}

let cache: SkinsCache = readCache();

/** This machine's skins, as last heard from the engine. */
export function skins(): readonly Skin[] {
  return cache.skins;
}

export const isPair = (v: unknown): v is Pair => PAIR_IDS.includes(v as Pair);
const isBuiltIn = (v: unknown): v is BuiltIn => PALETTES.includes(v as BuiltIn);
const isSkin = (v: unknown): v is Skin["id"] => typeof v === "string" && cache.skins.some((s) => s.id === v);
const isTheme = (v: unknown): v is Theme => isBuiltIn(v) || isSkin(v);

/** The picker's caption for a choice. */
export function labelFor(t: ThemeChoice): string {
  if (isPair(t)) return PAIRS[t].label;
  return isBuiltIn(t) ? THEME_LABEL[t] : (cache.skins.find((s) => s.id === t)?.label ?? t);
}

/** The OS preference, defensively: matchMedia is missing in a DOM-less test
 * environment and in very old webviews, and "no answer" means light. */
export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY).matches
    : false;
}

/** THE decision, pure: what data-theme the root should carry. A pair is the
 * OS's answer — Ink is "default" in light and "dusk" in dark — and "default"
 * is the one palette that needs no attribute, so Ink answers null there. Every
 * other answer names itself, "default" included: a card in the picker wears
 * its palette inside an app wearing another, and only an attribute can win
 * that. */
export function themeFor(systemDark: boolean, choice: ThemeChoice = DEFAULT_CHOICE): Theme | null {
  if (!isPair(choice)) return choice;
  const half = PAIRS[choice][systemDark ? "dark" : "light"];
  return half === "default" ? null : half;
}

/** The stored choice, or DEFAULT_CHOICE when none has been made (or storage
 * is unreadable — a private window, a webview with site data off). A value
 * that is no longer a palette reads as the default rather than throwing the
 * app onto a theme that does not exist — and the record itself is left
 * alone: a skin whose file is gone reads as Ink until the file is back,
 * then as itself again. */
export function storedChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return isPair(v) || isTheme(v) ? v : DEFAULT_CHOICE;
  } catch {
    return DEFAULT_CHOICE;
  }
}

/** Remember a choice and repaint. Every choice is STORED, Ink
 * included: an absent record happens to mean the same thing today, but a
 * written one is the person's decision, and it survives whatever an unset
 * record comes to mean later (it meant the blue for a day). */
export function setChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* the choice still applies to this session — it just won't survive it */
  }
  paint();
}

function paint(): void {
  const theme = themeFor(systemPrefersDark(), storedChoice());
  const root = document.documentElement;
  if (theme) root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  syncWindowBackground();
}

/** The skins' CSS on the page: one <style> in the head, replaced whole. */
function installCss(css: string): void {
  css = normalizeSkinsCss(css);
  // a hand-stubbed document (the tests) or none at all: nothing to inject into
  if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    if (!css) return; // no skins, no element
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

function adopt(next: SkinsCache): void {
  cache = next;
  try {
    localStorage.setItem(SKINS_KEY, JSON.stringify(next));
  } catch {
    /* this launch has them; the next will fetch again */
  }
  installCss(next.css);
  paint();
}

/** Ask the engine for this machine's skins, adopt them and repaint. Null
 * when there is no door here (a headless host's viewer) — and then the
 * cache is dropped too, since nothing on this origin can define a skin.
 * Throws when the engine is not answering; the caller keeps what it has. */
export async function loadSkins(): Promise<SkinsReport | null> {
  const r = await fetchSkins();
  adopt(r ? { skins: r.skins, css: r.css } : NONE);
  return r;
}

/** Re-read the record and repaint NOW. For a page that lives while the
 * choice is made elsewhere — the desktop shell's palette window is a
 * second page on the same origin, and a pick in settings → themes lands
 * in localStorage without this page hearing it. */
export function applyStoredTheme(): void {
  paint();
}

/** Paint from the choice (or the OS preference) now, and keep following the
 * OS for as long as the page is open — a repaint on the system's change is a
 * no-op while an explicit choice stands. Called before the app mounts, so the
 * first frame is already the right palette rather than a blue flash that
 * corrects itself. The skins come from the cache for that first frame and
 * from the engine right after — and again whenever the window is focused,
 * so a file saved in an editor shows on the next click into the app. */
export function watchSystemTheme(): void {
  cache = readCache(); // boot IS module init in the app; the tests stub storage between the two
  installCss(cache.css);
  paint();
  if (typeof window === "undefined") return;
  // Another window of this origin changed the choice or the skins (the app
  // beside the palette window, a second tab): storage events are how the
  // other pages hear it. Fires only in OTHER windows, never the one that
  // wrote.
  window.addEventListener("storage", (e) => {
    if (e.key === SKINS_KEY || !e.key) {
      cache = readCache();
      installCss(cache.css);
    }
    if (!e.key || e.key === KEY || e.key === SKINS_KEY) paint();
  });
  const refresh = (): void => {
    void loadSkins().catch(() => {
      /* the engine is not answering — the cache stands */
    });
  };
  refresh();
  window.addEventListener("focus", refresh);
  if (typeof window.matchMedia !== "function") return;
  window.matchMedia(DARK_QUERY).addEventListener("change", paint);
}
