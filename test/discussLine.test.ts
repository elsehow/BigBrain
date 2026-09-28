/**
 * The ONE discuss idiom (#64): every DISCUSS affordance copies the same
 * line, and the line must name a command that actually ships. The viewer
 * imports web/ui/src/lib/discuss.ts; the extension popup repeats the
 * literal (plain JS, no build step, no import); the Claude Code plugin
 * supplies the command the line invokes. Three sources, one contract —
 * this file is where a drift between them turns red instead of turning
 * into a field report.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discussLine } from "../web/ui/src/lib/discuss";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("discussLine is the plugin command with the path as its argument", () => {
  expect(discussLine("references/2026-08-13-kry10.md")).toBe(
    "/bigbrain:discuss references/2026-08-13-kry10.md"
  );
});

test("the popup copies the same idiom, verbatim", () => {
  expect(read("clients/browser-extension/popup.js")).toContain(
    "`/bigbrain:discuss ${landedPath}`"
  );
});

// #334: the spelling was never the bug — the PATH was. The popup pasted the
// drop receipt's `path`, which names the host's gitignored desk copy: under
// no READ_TREE, so /v1/note answered 403 on every clip, and deleted by
// triage besides. The receipt's `ref_path` is the committed reference, and
// it exists at the same instant. Covered here as source-of-path, since the
// two files that carry it ship as plain JS with no build step and no types.
test("the extension grounds the line on the REFERENCE path, never the desk copy", () => {
  const background = read("clients/browser-extension/background.js");
  const popup = read("clients/browser-extension/popup.js");

  // the drop receipt's readable half, and only that half
  expect(background).toContain("refPath: j.ref_path");
  expect(background).not.toContain("path: j.path");
  expect(popup).toContain("landedPath = msg.refPath");
  expect(popup).not.toContain("landedPath = msg.path");

  // No desk-copy second-best: a host that reports no reference path leaves
  // landedPath null and discuss() falls back to the search line, which
  // finds the clip. Pasting an inbox path would only 403 more quietly.
  expect(popup).not.toMatch(/landedPath\s*=\s*[^;]*\bmsg\.path\b/);
});

test("the command the line invokes ships in the plugin, under the namespace the line uses", () => {
  const manifest = JSON.parse(read("clients/claude-plugin/.claude-plugin/plugin.json")) as {
    name: string;
  };
  expect(manifest.name).toBe("bigbrain"); // the namespace in /bigbrain:discuss
  // The command resolves the identifier through MCP, not an agent filesystem read.
  expect(read("clients/claude-plugin/commands/discuss.md")).toContain("`read_note`");
});

test("the note viewer does not copy the retired local-file idiom", () => {
  expect(read("web/ui/src/components/NoteTab.svelte")).not.toContain("Read prompts/discuss.md");
});
