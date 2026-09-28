import { vaultFetch as fetch } from "./vaultScope";
/**
 * skins.ts — the settings › themes screen's half of the wire for this
 * machine's own palettes. The engine's lib/themes.ts answers these under
 * the desktop app only (the folder is on the machine the app runs on); a
 * headless host's viewer gets a 404, which reads as null here.
 *
 * The painting side — injecting the CSS, remembering it across launches,
 * offering the skins beside the built-ins — is lib/theme.ts's.
 */

export interface Skin {
  /** The data-theme value, `skin-<file stem>`. */
  id: `skin-${string}`;
  label: string;
  scheme: "light" | "dark";
  file: string;
}

export interface SkinError {
  file: string;
  error: string;
}

export interface SkinsReport {
  dir: string;
  skins: Skin[];
  /** One stylesheet for all of them, ready to inject. */
  css: string;
  errors: SkinError[];
}

/** The folder, read now — null when there is no desktop door here. */
export async function fetchSkins(): Promise<SkinsReport | null> {
  const r = await fetch("/api/themes", { headers: { Accept: "application/json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`themes answered ${r.status}`);
  return (await r.json()) as SkinsReport;
}

/** Show the folder in the OS (making it first). `ok: false` when the
 * engine could not — the path comes back either way, to show. */
export async function revealThemes(): Promise<{ ok: boolean; path: string }> {
  const r = await fetch("/api/themes/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`reveal answered ${r.status}`);
  return (await r.json()) as { ok: boolean; path: string };
}

/** Put the example skin in the folder — a full palette to copy. Never over
 * a file already there: `existed` says which happened. */
export async function writeExampleSkin(): Promise<{ ok: boolean; path: string; existed: boolean }> {
  const r = await fetch("/api/themes/example", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`example answered ${r.status}`);
  return (await r.json()) as { ok: boolean; path: string; existed: boolean };
}

/** Older running engines and first-frame caches can still send full palettes.
 * Reduce those to the new three-color contract before injecting any CSS. */
export function normalizeSkinsCss(css: string): string {
  return css.replace(/(\[data-theme="skin-[\w-]+"\]\s*\{)([^}]*)(\})/g, (block, start: string, body: string, end: string) => {
    const values = new Map([...body.matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]));
    if (!values.has("--text")) return block; // Already three-color CSS.
    const vars = [
      ["--bg", values.get("--bg")], ["--fg", values.get("--fg") ?? values.get("--text")],
      ["--activity", values.get("--activity") ?? values.get("--accent-1")],
      ...["--font-app", "--font-mono", "color-scheme"].map(k => [k, values.get(k)]),
    ];
    return `${start}\n${vars.filter(([, value]) => value).map(([k, value]) => `  ${k}: ${value};`).join("\n")}\n${end}`;
  });
}
