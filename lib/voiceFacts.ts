/** Voice vocabulary and envelope interpretation, independent of readers and writers. */

/** The three voice kinds (#521; standing orders join later, #53). */
export const VOICE_KINDS = ["directive", "request", "observation"] as const;
export type VoiceKind = (typeof VOICE_KINDS)[number];

/** Voice kinds that are DUE INTAKE WORK — settled by an assertion or
 * decline citing them. Observations are deliberately not here: they are
 * demand evidence for the memory pass (read via its insertion cursor),
 * and making the gardener "settle" each `--why` would manufacture noise. */
export const VOICE_DUE_KINDS: ReadonlySet<string> = new Set(["directive", "request"]);

export const isVoiceKind = (word: unknown): word is VoiceKind =>
  typeof word === "string" && (VOICE_KINDS as readonly string[]).includes(word);

/** Is this insertion a mind's words ABOUT the record rather than a piece of
 * it? The gardener settles a directive or request by citing it, which makes
 * it a "source" of the assertion in the log's terms. That citation is
 * HONEST — "Nick flagged the Semafor piece" is grounded in the directive
 * that flagged it — so this is a DRAWING rule, not a truth about evidence:
 * the graph does not draw a directive as a content node beside clips and
 * transcripts (Nick, 2026-08-30). Search does not use this; it ranks voice
 * last instead, because dropping it there also dropped every assertion
 * whose only source is voice (#641). */
export const isVoiceInsertion = (event: { envelope: Record<string, unknown> }): boolean =>
  isVoiceKind(event.envelope["kind"]);

/** `about:` read TOLERANTLY off any envelope: the voice landing writes a
 * string[], the legacy drop-zone stamp was a single string — both answer. */
export function aboutIds(envelope: Record<string, unknown>): string[] {
  const raw = envelope["about"];
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (Array.isArray(raw))
    return raw.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim());
  return [];
}

