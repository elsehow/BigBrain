/** Plain terms are matched together; uppercase OR separates alternatives.
 * Compile our small language to escaped FTS, never accept raw FTS syntax. */
export class SearchQueryError extends Error {}
export const searchTerms = (text: string): string[] =>
  text.toLocaleLowerCase().match(/[\p{L}\p{N}@._+-]+/gu) ?? [];
/** A short, explicitly capitalized initialism names a word, not a typed
 * prefix: GI must not become Giving/Gil. Lowercase typeahead is unchanged. */
export const exactSearchTerms = (query: string): Set<string> =>
  new Set((query.match(/\b[A-Z]{2,4}\b/g) ?? []).filter(t => t !== "OR").map(t => t.toLowerCase()));

export function searchAlternatives(query: string): string[][] {
  const parts = query.split(/(?<!\S)OR(?!\S)/u);
  if (parts.length > 8) throw new SearchQueryError("Use at most 8 alternatives separated by OR.");
  const groups = parts.map(searchTerms);
  if (parts.length > 1 && groups.some(g => !g.length))
    throw new SearchQueryError("OR needs search terms on both sides, e.g. gastroenterology OR GI appointment.");
  return groups.filter(g => g.length);
}

export function searchMatch(query: string, mode: "all" | "any" = "all"): string | undefined {
  const groups = searchAlternatives(query);
  const exact = exactSearchTerms(query);
  const quote = (term: string) => `"${term.replace(/"/g, '""')}"${exact.has(term) ? "" : "*"}`;
  if (mode === "any") return groups.flat().map(quote).join(" OR ") || undefined;
  return groups.map(g => `(${g.map(quote).join(" AND ")})`).join(" OR ") || undefined;
}
