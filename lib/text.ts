/**
 * text.ts — the little scalar/string helpers every envelope and log reader
 * kept re-declaring inline (#642): the same four lambdas lived in
 * memoryRun, voice, work, insertionLog, entityDossiers and
 * entityAliasSeed, drifting one keystroke at a time. Declared once.
 */

/** A trimmed, non-empty string, or undefined — the envelope-field reader:
 * anything that isn't prose (a number, an object, "") reads as absent. */
export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Like `str`, but a number is a value too — the insertion log's envelope
 * fields (ids, dates) arrive as either. */
export const scalar = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number"
    ? String(value).trim() || undefined
    : undefined;

/** Bound `s` to `n` chars, the marker included — "…" by default; the memory
 * prompt passes " …[clipped]" so the model is told the text was cut. */
export const clip = (s: string, n: number, marker = "…"): string =>
  s.length > n ? `${s.slice(0, Math.max(0, n - marker.length))}${marker}` : s;

/** A filename back to a label: `evan-keller.md` → "evan keller". */
export const deslug = (base: string): string =>
  base.replace(/\.md$/, "").replace(/[-_]+/g, " ").trim();
