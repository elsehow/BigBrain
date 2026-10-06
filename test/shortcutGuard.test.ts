import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Every key the app answers goes through the registry
// (web/ui/src/lib/shortcuts.svelte.ts), and every key it shows comes from
// there. #129 was a component whose keys ran through a side channel that
// died, under chips that kept advertising them; these rules make that shape
// fail here instead. A text field's own keys (Enter in a rename box, Tab
// wrapping in a dialog) are element handlers and stay where they are.
const root = new URL("../web/ui/src/", import.meta.url).pathname;
const registry = ["lib/shortcuts.svelte.ts", "lib/shortcutKeys.ts"];
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? (d.name === "dev" ? [] : files(join(dir, d.name))) : /\.(svelte|ts)$/.test(d.name) ? [join(dir, d.name)] : []);
const sources = files(root).map((f) => ({ path: relative(root, f), text: readFileSync(f, "utf8") })).filter((f) => !registry.includes(f.path));
// comments say ⌘O and Esc freely; code may not
const code = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const offenders = (re: RegExp) => sources.filter((f) => re.test(code(f.text))).map((f) => f.path);

test("no keyboard listener on the window or document but the registry's", () => {
  expect(offenders(/<svelte:(window|document|body)\b[^>]*\bonkey(down|up)/)).toEqual([]);
  expect(offenders(/\b(window|document)\.addEventListener\(\s*["'`]key(down|up)/)).toEqual([]);
});

test("no hand-typed key hints: chips, titles and aria come from keyText", () => {
  expect(offenders(/aria-keyshortcuts="/)).toEqual([]);
  expect(offenders(/<kbd[^>]*>\s*[^{<\s]/)).toEqual([]);
  expect(offenders(/[⌘⇧↵]|\bEsc\b|Shift\+Enter/)).toEqual([]);
});
