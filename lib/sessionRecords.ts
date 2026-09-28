/** Load durable conversations independently: damage to one record must not hide others. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SessionLoadIssue { file: string; message: string }
export function loadSessionRecords(directory: string, pattern: RegExp, issues: SessionLoadIssue[], load: (value: unknown, file: string) => void): void {
  let files: string[];
  try { files = readdirSync(directory); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") issues.push({ file: directory, message: "Conversation folder could not be read. Its files have been preserved." });
    return;
  }
  for (const name of files.filter(name => pattern.test(name)).sort()) {
    const file = join(directory, name);
    try { load(JSON.parse(readFileSync(file, "utf8")), file); }
    catch {
      issues.push({ file, message: "Conversation could not be loaded. Its saved record has been preserved." });
    }
  }
}
