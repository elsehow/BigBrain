import { join } from "node:path";
import { assertionGraphEvidenceAsync } from "./graphCache";
import { projectedMarkdown, withVaultSnapshot } from "./vaultReadModel";
import { sha256hex } from "./hash";
import { writeAtomic } from "./fsx";

export interface MemoryCategory { id: string; title: string; text: string }
export interface MemoryCatalogue {
  key: string;
  memories: MemoryCategory[];
  labels: ReadonlyMap<string, string>;
}
const cached = new Map<string, { revision: string; catalogue: MemoryCatalogue }>();

/** The same complete memories used by Quick previews, without a lossy model
 * summary. Rebuilt in the background; menu navigation never reads this cache. */
export async function memoryCategoryCatalogue(root: string): Promise<MemoryCatalogue> {
  const { graph, revision } = await assertionGraphEvidenceAsync(root);
  const previous = cached.get(root);
  if (previous?.revision === revision) return previous.catalogue;
  const memories = withVaultSnapshot(root, () => graph.nodes
    .filter(n => n.group === "memory" && n.path && !/(^|\/)MEMORY\.md$/.test(n.path))
    .map(n => {
      const text = projectedMarkdown(root, n.path!);
      if (text === undefined) throw new Error("Memory catalogue changed while it was being read.");
      return { id: n.id, title: n.title, text };
    }).sort((a, b) => a.id.localeCompare(b.id)));
  const serialized = JSON.stringify(memories);
  if (serialized.length > 120_000) throw new Error("Memory category catalogue exceeds Quick's input budget.");
  const key = sha256hex(serialized);
  const labels = new Map<string, string>();
  for (const node of graph.nodes) for (const alias of [node.id, node.path, ...(node.memberPaths ?? [])]) {
    if (alias && !labels.has(alias)) labels.set(alias, node.title);
  }
  const catalogue = { key, memories, labels };
  if (previous?.catalogue.key !== key) writeAtomic(join(root, ".state", "memory-categories.json"), JSON.stringify({ key, memories }), 0o600);
  cached.set(root, { revision, catalogue });
  return catalogue;
}
