/** Immutable source facts needed by graph/feed reads, computed once at ingestion. */
import type { SourceInsertion, SourceMetadata } from "./insertionLog";
import { intakePriority } from "./intakeClass";

export interface SourceSummary extends SourceMetadata {
  excerpt: string;
  intakePriority: number | null;
  /** The model its attached Claude Code transcript names, as the projection
   * read it once (null: none); absent where no projection read it. */
  transcriptModel?: string | null;
}
export function sourceSummary(source: SourceInsertion): SourceSummary {
  const { body, ...metadata } = source;
  const field = (key: string) => typeof source.envelope[key] === "string" ? source.envelope[key] as string : undefined;
  return {
    ...metadata,
    excerpt: sourceExcerpt(body),
    intakePriority: intakePriority({ kind: field("kind"), type: field("type"), source: field("source") }, body),
  };
}

/** Collapse only enough text for the preview, rather than normalizing a
 * multi-megabyte transcript to discard all but its first 240 characters. */
export function sourceExcerpt(body: string): string {
  let out = "";
  let space = false;
  for (const part of body.matchAll(/\s+|[^\s]{1,240}/gu)) {
    if (/^\s/u.test(part[0])) { space = !!out; continue; }
    out += (space ? " " : "") + part[0];
    space = false;
    if (out.length >= 240) return out.slice(0, 240);
  }
  return out;
}
