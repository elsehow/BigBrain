/** Recover model metadata omitted by older Claude transcript imports from
 * their saved raw attachment. The source log remains immutable. */
import { readFileSync } from "node:fs";
import { getBlobPath } from "./blobs";
import { projectSegment } from "./transcriptProjection";

// Cache only the small derived value, never transcript contents. A missing
// blob is retried on the next read, so restoring attachments repairs the view.
const models = new Map<string, string | undefined>();

export function savedClaudeModel(root: string, attachments: unknown): string | undefined {
  if (!Array.isArray(attachments)) return undefined;
  for (const a of attachments) {
    if (!a || typeof a.name !== "string" || !a.name.endsWith(".jsonl")
      || typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256)) continue;
    try {
      const path = getBlobPath(root, a.sha256);
      if (!path) continue;
      if (!models.has(path)) {
        const model = projectSegment(readFileSync(path, "utf8")).model;
        if (models.size >= 2048) models.delete(models.keys().next().value!);
        models.set(path, model);
      }
      const model = models.get(path);
      if (model) return model;
    } catch { /* missing or unreadable metadata leaves the cell blank */ }
  }
  return undefined;
}
