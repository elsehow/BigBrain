import { assertionGraphEvidenceAsync } from "./graphCache";
import { createNoteBriefingService } from "./noteBriefing";
import { memoryCategoryCatalogue } from "./memoryCategories";

/** Sequential, content-addressed warming after a successful memory pass.
 * A Quick failure never changes the committed memory or its success status. */
export async function warmMemoryBriefings(root: string, generate = createNoteBriefingService()) {
  const { graph } = await assertionGraphEvidenceAsync(root);
  try { await memoryCategoryCatalogue(root); }
  catch (error) { console.warn(`Quick memory catalogue: ${error instanceof Error ? error.message : error}`); }
  const paths = graph.nodes.filter(n => n.group === "memory" && n.path && !/(^|\/)MEMORY\.md$/.test(n.path))
    .map(n => n.path!).sort();
  const failures: string[] = [];
  for (const path of paths) {
    try { await generate(root, path); }
    catch (error) { failures.push(path); console.warn(`Quick memory preview (${path}): ${error instanceof Error ? error.message : error}`); }
  }
  return { warmed: paths.length - failures.length, failures };
}
