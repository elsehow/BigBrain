/** Bounded evidence shared by note briefings. The Quick model they call is a
 * stage's (lib/stages/quick.ts). */
import type { ProjectedEntityAssertion, ProjectedEntityView } from "./assertionEntityView";
const MAX_CHARS = 24_000;

/** Recent evidence gets half the budget; spread the rest across the history.
 * Whole assertions only. The displayed coverage makes omissions explicit. */
export function briefingEvidence(view: ProjectedEntityView): ProjectedEntityAssertion[] {
  const rows = [...view.assertions].filter(a => a.sources.length).sort((a, b) =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const chosen = new Set<ProjectedEntityAssertion>();
  let used = 0;
  const size = (row: ProjectedEntityAssertion) => JSON.stringify(row).length;
  for (const row of [...rows].reverse()) {
    if (chosen.size >= 40 || used + size(row) > MAX_CHARS / 2) break;
    chosen.add(row); used += size(row);
  }
  const older = rows.filter(row => !chosen.has(row));
  // Evenly spaced candidates retain background on large nodes.
  const count = Math.min(40, older.length);
  for (let i = 0; i < count; i++) {
    const row = older[Math.floor(i * older.length / count)]!;
    if (used + size(row) > MAX_CHARS) continue;
    chosen.add(row); used += size(row);
  }
  return rows.filter(row => chosen.has(row));
}
