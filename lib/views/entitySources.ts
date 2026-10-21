/** Sources behind a concept's live claims. Browser-safe metadata; summaries
 * come from the existing Quick note briefing, not from a stored assertion. */
export interface EntitySource {
  id: string;
  path: string;
  title: string;
  /** When this source entered the vault, not its publication or claim date. */
  added: string;
  via?: string;
}

export const sourcesNewestFirst = (a: EntitySource, b: EntitySource): number =>
  (Date.parse(b.added) || 0) - (Date.parse(a.added) || 0) || a.path.localeCompare(b.path);
