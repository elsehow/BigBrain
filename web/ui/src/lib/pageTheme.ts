/**
 * pageTheme.ts — how a page an agent shows on a desktop is dressed.
 *
 * Agents send semantic HTML only (show_html, lib/codingDesktops.ts) and are
 * told not to write CSS: the page wears BigBrain's own style, read live from
 * the theme the person is using, so it matches in any skin, light or dark,
 * and the agent spends no tokens on styling. The same sheet is written to
 * the workspace (bigbrain.css) for pages an agent serves itself.
 */

/** The theme's values a page needs, read off v2's root element. */
const TOKENS = ["--bg", "--fg", "--rule", "--activity", "--accent-1", "--accent-2", "--accent-3", "--accent-4", "--accent-5",
  "--font-app", "--font-mono", "--v2-muted", "--v2-faint"];

export function themeVars(el: Element): string {
  const cs = getComputedStyle(el);
  return `:root{${TOKENS.map((t) => { const v = cs.getPropertyValue(t).trim(); return v ? `${t}:${v};` : ""; }).join("")}}`;
}

/** Classless: headings, prose, lists, tables, code, figures and SVG look right as written.
 * A few classes for what tags can't say: .muted .faint .accent .num .grid .card */
export const PAGE_CSS = `
*{box-sizing:border-box}
body{margin:0;padding:20px 24px 28px;background:var(--bg);color:var(--fg);font:400 15px/1.6 var(--font-app,system-ui,sans-serif);overflow-wrap:anywhere}
body>*{max-width:76ch}
body>table,body>.grid,body>figure,body>svg{max-width:none}
h1,h2,h3,h4{font-weight:600;line-height:1.3;margin:1.2em 0 .5em}
h1{font-size:1.45em;letter-spacing:-.01em}h2{font-size:1.2em}h3{font-size:1.05em}
body>:first-child{margin-top:0}
p,ul,ol,table,pre,figure,blockquote,dl{margin:0 0 .9em}
ul,ol{padding-left:1.4em}li+li{margin-top:.25em}
a{color:inherit;text-decoration-color:color-mix(in srgb,var(--fg) 40%,transparent);text-underline-offset:3px}
strong,b{font-weight:600}
code,kbd{font:400 .88em/1.4 var(--font-mono,ui-monospace,monospace);background:color-mix(in srgb,var(--fg) 8%,transparent);padding:.1em .3em;border-radius:4px}
pre{background:color-mix(in srgb,var(--fg) 7%,var(--bg));padding:12px 14px;border-radius:8px;overflow:auto}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;font-size:.94em;display:block;overflow-x:auto}
th,td{text-align:left;padding:.45em .7em;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-weight:600;color:var(--v2-muted,var(--fg))}
.num,td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
blockquote{border-left:2px solid var(--rule);padding-left:1em;color:var(--v2-muted,var(--fg))}
hr{border:0;border-top:1px solid var(--rule);margin:1.4em 0}
dt{font-weight:600}dd{margin:0 0 .5em}
figcaption{color:var(--v2-muted,var(--fg));font-size:.88em;margin-top:.4em}
svg{max-width:100%;height:auto}svg:not([width]){width:100%;max-width:560px}svg text{fill:currentColor;font-family:var(--font-app,system-ui,sans-serif)}
.muted{color:var(--v2-muted,var(--fg))}.faint{color:var(--v2-faint,var(--fg))}.accent{color:var(--activity)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:0 0 1em}
.card{border:1px solid var(--rule);border-radius:10px;padding:12px 14px}
.card>:first-child{margin-top:0}.card>:last-child{margin-bottom:0}
`;

const FONTS = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400&display=swap";

/** A whole page from an agent's HTML, dressed in the theme. It is shown in a frame with no scripts. */
export function pageDoc(html: string, vars: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS}"><style>${vars}${PAGE_CSS}</style></head><body>${html}</body></html>`;
}

/** The workspace's bigbrain.css: the same style, for pages an agent serves itself. */
export const themeSheet = (vars: string): string => `@import url("${FONTS}");\n${vars}\n${PAGE_CSS}`;
