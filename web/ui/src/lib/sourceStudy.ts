/** Optional UI study supplied by a fabricated-vault workbench, never by the app. */
export const SOURCE_STUDY = Symbol("source-study");
export interface StudySource {
  path: string;
  title: string;
  meta: string;
  excerpt: string;
}
export interface SourceStudy {
  initialEntity: string;
  sources: Record<string, StudySource[]>;
}
