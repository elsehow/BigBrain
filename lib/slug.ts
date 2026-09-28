/**
 * slug.ts — the vault's one text→identifier normalizer: lowercase, every
 * run of non-alphanumerics collapses to one hyphen, leading/trailing
 * hyphens trimmed. slug("Ada Lovelace") === "ada-lovelace".
 *
 * Two call shapes lived here independently before #265 and both survive
 * under this one function:
 *   - fsx.ts's filename generator capped length at 60 (a slug that long is
 *     a filesystem hostility, not a title) and fell back to a default when
 *     the input slugged to nothing (an all-punctuation title, or no title
 *     at all).
 *   - graph.ts's and links.ts's wikilink matchers capped neither: a slug()
 *     there is a lookup KEY into a Map, matched against another slug() call
 *     on the other side of the same link. Capping one side and not the
 *     other would silently break long-title matches; a fallback string
 *     would make two different untitled notes collide on the same key.
 * `maxLen` and `fallback` default to off, so a bare `slug(s)` call matches
 * the graph/links behavior exactly; fsx.ts opts into both explicitly. This
 * makes callers safe by construction — the stricter behavior is opt-in,
 * never inherited by accident.
 */
export function slug(s: string, opts: { maxLen?: number; fallback?: string } = {}): string {
  const { maxLen, fallback = "" } = opts;
  let out = (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (maxLen) out = out.slice(0, maxLen);
  return out || fallback;
}
