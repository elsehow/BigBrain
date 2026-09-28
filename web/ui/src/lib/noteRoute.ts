/** Paths the single-note UI can open. Native source events are virtual notes;
 * everything else remains the legacy Markdown surface. */
export function isNotePath(path: string): boolean {
  return path.endsWith(".md") ||
    /^projection\/entities\/ent_[a-f0-9]{20}\.md$/u.test(path) ||
    /^log\/insertions\/(?:\d{4}-\d{2}|undated)\/ins_[a-f0-9]{24}\.json$/u.test(path);
}
