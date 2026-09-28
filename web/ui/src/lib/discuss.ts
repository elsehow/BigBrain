// The one discuss idiom: the grounding line every DISCUSS affordance
// copies. RecentTab and NoteTab share it through DiscussChip.svelte (the
// markup+CSS) and copyDiscussPrompt below (the clipboard write,
// copied-state flash and 1600ms timer) — both call sites carried their own
// copy of that ritual before this consolidation (#265). The extension
// popup repeats the literal in popup.js (the extension ships as plain JS
// with no build step, so it cannot import it) — test/discussLine.test.ts
// holds the two together.
//
// discussLine is the Claude Code plugin's command, plugin-namespaced so it
// resolves in any session on a machine that has connected (`/connect`
// installs the plugin at user scope; the bare `/discuss` only resolves
// while no other command claims the name). The line it replaces — "Read
// prompts/discuss.md and follow it for <path>" — assumed the session sat
// inside a vault checkout: pasted into a hosted user's session it
// commanded a filesystem Read of two files that exist only on the server,
// and the agent went hunting local directories for a vault that isn't
// there (#64, field reports 2026-08-13). `prompts/discuss.md` was the
// in-checkout equivalent until #507 — it was seeded into every vault and
// invoked by nothing, so it went with the rest of the vault-shipped
// reference-era text.
//
// The path may be seconds old — an arrival is discussable the moment it
// lands, before the gardener has asserted anything about it; the command's own
// search fallback covers a note triage has since renamed.
export const discussLine = (path: string): string => `/bigbrain:discuss ${path}`;

/** Copy the DISCUSS line for `path`, then flash `onCopied(true)` and — after
 * 1600ms — `onCopied(false)`. Silent on a clipboard failure (non-secure
 * context): the caller's button just doesn't confirm, same as before. */
export async function copyDiscussPrompt(
  path: string,
  onCopied: (copied: boolean) => void
): Promise<void> {
  try {
    await navigator.clipboard.writeText(discussLine(path));
    onCopied(true);
    setTimeout(() => onCopied(false), 1600);
  } catch {
    /* clipboard unavailable (non-secure context) — button just doesn't confirm */
  }
}
