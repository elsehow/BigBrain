/**
 * hook.ts — render and install the interactive-session write guard: a
 * user-global Claude Code PreToolUse hook that makes vault content
 * read-only outside the sanctioned runners. Lives in ~/.claude/settings.json
 * (user-global because it must gate every session on the machine regardless
 * of cwd). bin/hook.ts is the CLI; init's --check reads hookInstalled().
 *
 * Semantics:
 *  - BIGBRAIN_ROLE set → the machine's write key: everything is allowed
 *    EXCEPT queue/ and log/, which stay denied (#67). The runner moves
 *    messages and appends log events in-process, never through a model's
 *    Bash, so nothing legitimate needs the write — they are the audit
 *    spines, and a record that can vanish untracked breaks "decline is
 *    terminal, nothing is silent". A command that merely SAYS "queue"
 *    still passes: the guard matches `queue/` tokens, not words.
 *  - interactive: deny references/ entities/ log/ lake/ queue/ memory/
 *    observations/ .blobs/ — machine-written-only planes (intake code and
 *    the sanctioned passes, never a model or a hand-edit); inbox writes
 *    are legitimate.
 *
 * Each installed entry carries the marker `: bigbrain-guard <root>;` so this
 * module can find, replace, and remove ITS entries without ever touching a
 * user's other hooks.
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeAtomic } from "./fsx";

export const HOOK_MARKER = "bigbrain-guard";

export function settingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

// ".blobs" needs its dot escaped for the jq regex — same double-escape as
// regexEscape() below (once for JSON-in-jq, once for the regex engine).
const GUARDED_TREES = "entities|references|log|lake|queue|memory|observations|\\\\.blobs|\\\\.spool";

/** What a SANCTIONED MACHINE PASS still may not touch (#67): the audit
 * spines. The runner's own queue moves and log appends are in-process,
 * so denying the model's Bash here costs nothing it is allowed to
 * do. On 2026-08-07 a person's directive disappeared from `queue/pending/`
 * with no trace, and the leading candidate was a pass tidying "stray"
 * untracked files with BIGBRAIN_ROLE set — which bypassed this guard entirely. */
const MACHINE_TREES = "queue|log";

const MACHINE_REASON =
  "queue/ and log/ are audit spines whose lifecycle belongs to host code. " +
  "A machine pass never writes or deletes them (see #67). " +
  "To submit work, use bigbrain drop; to submit evidence, bigbrain observe.";

const GUARD_REASON =
  "The vault record (references/, entities/) is machine-written only (the gardener), " +
  "and queue/ lifecycle belongs to the runner: " +
  "submit changes via inbox/ — bigbrain drop <file>. " +
  "memory/ and observations/ belong to the memory pass: feed them with " +
  "bigbrain observe or bigbrain search --why, never a direct write.";

/** Escape a path for use inside a jq regex (which is also inside a shell
 * single-quoted string — so no single quotes can appear at all). */
function regexEscape(path: string): string {
  if (path.includes("'"))
    throw new Error(`vault path contains a single quote — the hook can't guard it: ${path}`);
  return path.replace(/[.*+?^${}()|[\]\\]/g, "\\\\$&"); // double-escaped: once for JSON-in-jq, once for regex
}

/** One jq program: deny when the tool touches any of `trees`, else stay
 * silent. Both the interactive guard and the machine guard are this same
 * program over a different tree list — the matching rule must not drift
 * between them. */
function guardProgram(root: string, trees: string, reason: string): string {
  const rootRe = regexEscape(root);
  return (
    `([.tool_input.file_path?, .tool_input.notebook_path?, .tool_input.command?] | map(select(type=="string")) | join(" ")) as $t | ` +
    `(.cwd // "") as $c | ` +
    `if (($t | test("${rootRe}/(${trees})")) or (($c | startswith("${root}")) and ($t | test("(^|[^A-Za-z0-9_./-])(${trees})/")))) ` +
    `then {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"${reason}"}} ` +
    `else empty end`
  );
}

/** The full hook shell command for this checkout.
 *
 * A machine pass no longer exits early. It runs the SAME guard over one tree
 * — `queue/` — so the audit spine is closed to the model on both paths
 * (#67). Exactly one branch reads stdin, so the hook input is consumed once
 * either way. */
export function renderHookCommand(root: string): string {
  const machine = guardProgram(root, MACHINE_TREES, MACHINE_REASON);
  const interactive = guardProgram(root, GUARDED_TREES, GUARD_REASON);
  return (
    `: ${HOOK_MARKER} ${root}; ` +
    `if [ -n "$BIGBRAIN_ROLE" ]; then jq -c '${machine}'; else jq -c '${interactive}'; fi`
  );
}

export interface HookEntry {
  matcher: string;
  hooks: { type: "command"; command: string; timeout: number }[];
}

export function renderHookEntry(root: string): HookEntry {
  return {
    matcher: "Write|Edit|NotebookEdit|Bash",
    hooks: [{ type: "command", command: renderHookCommand(root), timeout: 10 }],
  };
}

type Settings = { hooks?: Record<string, unknown[]> } & Record<string, unknown>;

export function readSettings(): Settings {
  const p = settingsPath();
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Settings; // malformed settings should throw, loudly — never overwrite what we can't parse
}

function isOurs(entry: unknown, root: string): boolean {
  const hooks = (entry as HookEntry)?.hooks;
  const marker = `${HOOK_MARKER} ${root};`;
  return Array.isArray(hooks) && hooks.some((h) => typeof h?.command === "string" && h.command.includes(marker));
}

/** Is this checkout's guard present in the user-global settings? */
export function hookInstalled(root: string): boolean {
  try {
    const pre = readSettings().hooks?.["PreToolUse"];
    return Array.isArray(pre) && pre.some((e) => isOurs(e, root));
  } catch {
    return false;
  }
}

/** Merge this checkout's guard into a settings object (replace-by-marker or
 * append; everything else untouched). Returns the new object and whether it
 * differs from the input. */
export function mergeHook(
  settings: Settings,
  root: string
): { settings: Settings; changed: boolean } {
  const entry = renderHookEntry(root);
  const out: Settings = { ...settings, hooks: { ...settings.hooks } };
  const pre = [...((out.hooks!["PreToolUse"] as unknown[]) ?? [])];
  const i = pre.findIndex((e) => isOurs(e, root));
  const before = JSON.stringify(i === -1 ? undefined : pre[i]);
  if (i === -1) pre.push(entry);
  else pre[i] = entry;
  out.hooks!["PreToolUse"] = pre;
  return { settings: out, changed: before !== JSON.stringify(entry) };
}

/** Write settings.json with a timestamped backup of the old file first.
 * The single mutation path for the user-global file — bin/hook.ts and
 * install's refresh both go through here. */
export function writeSettingsWithBackup(next: object): { path: string; backup?: string } {
  const path = settingsPath();
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
  }
  writeAtomic(path, JSON.stringify(next, null, 2) + "\n");
  return { path, backup };
}

/** Refresh an ALREADY-INSTALLED guard entry to the current rendering —
 * install's half of the hook story (#60). First-time install stays an
 * explicit consented step (bin/hook.ts --apply, via /setup): this never
 * adds an entry, only updates one whose consent was already given.
 * Returns what happened; "unparseable" means settings.json exists but
 * isn't valid JSON — the caller should warn, never fail. */
export function refreshHook(root: string): "absent" | "current" | "refreshed" | "unparseable" {
  if (!hookInstalled(root)) return "absent";
  let settings: Settings;
  try {
    settings = readSettings();
  } catch {
    return "unparseable";
  }
  const r = mergeHook(settings, root);
  if (!r.changed) return "current";
  writeSettingsWithBackup(r.settings);
  return "refreshed";
}

/** Strip this checkout's guard from a settings object. */
export function removeHookFrom(
  settings: Settings,
  root: string
): { settings: Settings; changed: boolean } {
  const pre = settings.hooks?.["PreToolUse"];
  if (!Array.isArray(pre)) return { settings, changed: false };
  const kept = pre.filter((e) => !isOurs(e, root));
  if (kept.length === pre.length) return { settings, changed: false };
  const out: Settings = { ...settings, hooks: { ...settings.hooks } };
  if (kept.length) out.hooks!["PreToolUse"] = kept;
  else delete out.hooks!["PreToolUse"];
  if (!Object.keys(out.hooks!).length) delete out.hooks;
  return { settings: out, changed: true };
}
