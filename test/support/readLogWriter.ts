/** One of two processes appending to the same read log at once, for
 * test/readLog.test.ts: `bun readLogWriter.ts <dir> <tag> <count>`. Each line
 * is ~3 KiB, so an interleaved append would show as a broken line. */
import { appendRead } from "../../lib/readLog";

const [dir, tag, count] = process.argv.slice(2) as [string, string, string];
for (let i = 0; i < Number(count); i++)
  appendRead(dir, { ts: new Date(Date.UTC(2026, 9, 7, 12, 0, 0, i)).toISOString(), caller: `token:${tag}`, label: tag, integration: "email",
    account: "me@example.com", tool: "email_search", args: { query: `${tag} ${i} `.padEnd(3000, tag) }, outcome: "refused", ms: i }, Date.UTC(2026, 9, 7));
