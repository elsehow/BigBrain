/** Search current memory from the same published snapshot as the record. */
import { withVaultSnapshot } from "./vaultReadModel";
import type { MarkdownDocument } from "./markdownGraph";
import { basename } from "node:path";
import { jailMemoryNotePath } from "./noteRead";
import { stripMemoryProvenance } from "./memoryProvenance";
import { searchAlternatives, searchTerms, exactSearchTerms } from "./searchQuery";
import type { RankedHit, SearchFilters } from "./searchCore";

export function searchMemory(root: string, query: string, filters: SearchFilters, mode: "all" | "any"): RankedHit[] {
  // A memory summary has neither a connector nor an event date. Its file
  // modification time must not masquerade as the date of an appointment.
  if (filters.source || filters.type || filters.after || filters.before) return [];
  const groups = searchAlternatives(query);
  const exact = exactSearchTerms(query);
  if (!groups.length || !jailMemoryNotePath(root, "memory/")) return [];
  return withVaultSnapshot(root, db => {
    const hits: RankedHit[] = [];
    const documents = db.query("SELECT document_json FROM markdown_documents WHERE path LIKE 'memory/%' ORDER BY path").all() as { document_json: string }[];
    for (const row of documents) {
      const { path, body: raw } = JSON.parse(row.document_json) as MarkdownDocument;
      // a claim's source stamp (lib/memoryProvenance.ts) is the runner's, not the memory's words
      const body = stripMemoryProvenance(raw);
      if (!jailMemoryNotePath(root, path)) continue;
      const title = body.match(/^#\s+(.+)$/m)?.[1] ?? basename(path, ".md");
      const doc = { title, body, words: new Set(searchTerms(`${title}\n${body}`)) };
      const includes = (term: string) => exact.has(term) ? doc.words.has(term) : [...doc.words].some(word => word.startsWith(term));
      const matches = mode === "any" ? groups.flat().some(includes) : groups.some(g => g.every(includes));
      if (!matches) continue;
      const titleWords = searchTerms(doc.title);
      const tier = groups.some(g => g.join(" ") === titleWords.join(" ")) ? 0 :
        groups.some(g => g.every(t => titleWords.some(w => w.startsWith(t)))) ? 1 : 2;
      const lower = doc.body.toLocaleLowerCase();
      const positions = groups.flat().map(t => lower.indexOf(t)).filter(i => i >= 0);
      const start = Math.max(0, Math.min(...positions) - 80);
      hits.push({ path, title: doc.title, snippet: doc.body.slice(start, start + 350).replace(/\s+/gu, " ").slice(0, 240),
        date: "", score: 0, tier, entity: false, evidence: "memory" });
    }
    return hits;
  });
}
