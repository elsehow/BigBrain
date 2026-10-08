/** Rebuildable file metadata. Durable JSON remains authoritative; no result bodies
 * enter this database. A cheap filesystem census detects external edits/deletion. */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
export interface HistoryMetadata<T> { group: string; order: string; summary: T }
export interface HistoryQuery { group?: string; limit?: number; after?: { order: string; file: string } }
export interface HistoryRow<T> { file: string; order: string; summary: T }
const DATABASE_FILES = ["", "-wal", "-shm", "-journal"];
export function readHistoryIndex<T>(root: string, name: string, directory: string, pattern: RegExp,
  summarize: (file: string) => HistoryMetadata<T>, query: HistoryQuery = {}): { rows: HistoryRow<T>[]; damaged: number; problems: string[]; more: boolean } {
  let files: string[];
  try { files = readdirSync(directory).filter(file => pattern.test(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") files = []; else throw error; }
  const cache = join(root, ".state", "application-history"); mkdirSync(cache, { recursive: true });
  const path = join(cache, name + ".sqlite");
  // A version bump (pilots-v2 → pilots-v3) abandons the earlier databases;
  // the new one clears them as it is created.
  if (!existsSync(path)) {
    const [, base, version] = /^(.+)-v(\d+)$/.exec(name) ?? [];
    for (let v = 1; v < Number(version ?? 0); v++) for (const suffix of DATABASE_FILES) rmSync(join(cache, `${base}-v${v}.sqlite${suffix}`), { force: true });
  }
  const run = () => {
    const db = new Database(path, { create: true });
    try {
      db.exec("CREATE TABLE IF NOT EXISTS records (file TEXT PRIMARY KEY, signature TEXT NOT NULL, actor TEXT, ordering TEXT, summary TEXT, damaged INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS actor_order ON records(actor, ordering DESC, file ASC)");
      const held = new Map((db.query("SELECT file, signature FROM records").all() as { file: string; signature: string }[]).map(row => [row.file, row.signature]));
      const put = db.query("INSERT OR REPLACE INTO records VALUES (?, ?, ?, ?, ?, ?)");
      db.transaction(() => {
        for (const file of files) {
          const at = join(directory, file);
          let signature = "unreadable";
          try { const stat = statSync(at); signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; } catch { /* Record damage is reported independently. */ }
          const prior = held.get(file); held.delete(file);
          if (signature === prior && signature !== "unreadable") continue;
          try {
            const value = summarize(at);
            // Keep the pre-read signature: a concurrent edit (or recovery write)
            // must be reconsidered by the next census, not marked as indexed.
            put.run(file, signature, value.group, value.order, JSON.stringify(value.summary), 0);
          } catch { put.run(file, signature, null, null, null, 1); }
        }
        const remove = db.query("DELETE FROM records WHERE file = ?");
        for (const file of held.keys()) remove.run(file);
      })();
      const damaged = (db.query("SELECT COUNT(*) AS n FROM records WHERE damaged = 1").get() as { n: number }).n;
      const where = ["damaged = 0"], params: (string | number)[] = [];
      if (query.group !== undefined) { where.push("actor = ?"); params.push(query.group); }
      if (query.after) { where.push("(ordering < ? OR (ordering = ? AND file > ?))"); params.push(query.after.order, query.after.order, query.after.file); }
      const limit = query.limit ?? Number.MAX_SAFE_INTEGER;
      params.push(limit < Number.MAX_SAFE_INTEGER ? limit + 1 : limit);
      const rows = db.query(`SELECT file, ordering, summary FROM records WHERE ${where.join(" AND ")} ORDER BY ordering DESC, file ASC LIMIT ?`).all(...params) as { file: string; ordering: string; summary: string }[];
      const problems = (db.query("SELECT file FROM records WHERE damaged = 1 ORDER BY file LIMIT 100").all() as { file: string }[]).map(row => row.file);
      return { problems, rows: rows.slice(0, limit).map(row => ({ file: row.file, order: row.ordering, summary: JSON.parse(row.summary) as T })), damaged, more: rows.length > limit };
    } finally { db.close(); }
  };
  try { return run(); }
  catch {
    // Only the derived database is discarded, never an authoritative record.
    for (const suffix of DATABASE_FILES) rmSync(path + suffix, { force: true });
    return run();
  }
}
