/**
 * WHOSE WORDS ARE THESE? (issue #34) — the voice claim on drop-zone imports.
 *
 * `from`/`from_kind` is not who SENT an item (`submitted_by` carries that);
 * it asserts whose words the content is, and person-stamped text reads as
 * the user VERBATIM downstream (prompts/memory.md's discipline, the
 * editor's renderGuidance). The edge credential stamps `person` onto
 * whatever it lands — right for text the user typed, wrong for a document
 * they merely delivered — and the credential cannot tell those apart; only
 * the composing client knows. So the client says so: every import claims
 * AGENT voice through the sanctioned escape hatch (lib/intake.ts
 * stampIntake: a payload may claim agent, never person), while the typed
 * capture and the note-beside-a-drop claim nothing and correctly inherit
 * the person stamp. Same resolution the browser extension shipped for its
 * clips. The claim also holds on the tunnel path, which ships composed
 * items unstamped — a server-side fix could not reach it.
 */

/** Frontmatter pairs for items DropZone composes itself (pdf/text/file
 * imports) — spread into the fm() block beside title/filename/date. */
export const AGENT_VOICE: [string, string][] = [
  ["from", "web-drop"],
  ["from_kind", "agent"],
];

// stampIntake's exact claim shapes (lib/intake.ts) — a claim these match
// is already honored server-side, so a file carrying one keeps it.
const KIND_CLAIM = /^from_kind:\s*["']?agent["']?\s*$/m;
const FROM_CLAIM = /^from:\s*["']?[^"'\n]+?["']?\s*$/m;

/** Inject the agent-voice claim into a verbatim .md item, which ships as
 * composed and so must carry its own claim. An existing complete agent
 * claim is kept — the original composer's name beats ours. Anything else
 * under from/from_kind is dropped first: a payload's person claim is never
 * honored anyway (stampIntake strips it), and a stray line beside ours
 * would make the claim ambiguous. Single-line values only — multi-line
 * forgeries are stripFmKeys' problem on the server, not this guard's. */
export function claimAgentVoice(text: string): string {
  const claim = 'from: "web-drop"\nfrom_kind: "agent"';
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return `---\n${claim}\n---\n\n${text}`;
  const fm = m[1]!;
  if (KIND_CLAIM.test(fm) && FROM_CLAIM.test(fm)) return text;
  const kept = fm
    .split("\n")
    .filter((l) => !/^["']?from(_kind)?["']?\s*:/.test(l))
    .join("\n");
  return `---\n${kept ? `${kept}\n` : ""}${claim}\n---\n${text.slice(m[0].length)}`;
}
