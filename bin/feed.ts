/**
 * bigbrain feed — the classic chain's feed stage (lib/feedStage.ts), read
 * from its journal: what needs you, what an agent could do, and what is worth
 * knowing, one headline per source.
 *
 *   bigbrain feed            the feed as it stands
 *   bigbrain feed --json     the same entries as JSON
 *   bigbrain feed --run      run the stage once now (it also runs on its own
 *                            after tend's memory pass, when due)
 *
 * Needs a `feed:` block in vault.yaml (vault.example.yaml has one).
 */

import { requireVaultRoot } from "../lib/engine";
import { hasFlag } from "../lib/cliflags";
import { currentFeed, feedRecords, type FeedEntry } from "../lib/feedJournal";
import { feedDue, runFeed } from "../lib/feedStage";
import { loadManifest } from "../lib/manifest";

const argv = process.argv.slice(2);
const root = requireVaultRoot();
const manifest = loadManifest(root);

if (!manifest.feed) {
  console.error("feed: off — add a feed: block to vault.yaml (see vault.example.yaml)");
  process.exit(2);
}

if (hasFlag(argv, "run")) {
  const result = await runFeed({ root, manifest });
  if (!result.ran) console.error(`feed: ${result.reason}`);
  for (const c of result.calls)
    console.error(`feed: call ${c.runId} — ${c.sources} source(s), ${c.entries} entr${c.entries === 1 ? "y" : "ies"}` +
      (c.usage?.cost_usd != null ? ` ($${c.usage.cost_usd.toFixed(4)})` : "") + (c.error ? ` — ERROR: ${c.error}` : ""));
  if (result.ran && !result.calls.length) console.error("feed: nothing new to sort");
}

const entries = currentFeed(feedRecords(root), new Date().toLocaleDateString("en-CA"));
if (hasFlag(argv, "json")) {
  console.log(JSON.stringify(entries, null, 2));
} else {
  const titles: [FeedEntry["section"], string][] = [["needs-you", "NEEDS YOU"], ["agent", "AN AGENT COULD HANDLE"], ["know", "WORTH KNOWING"]];
  for (const [section, title] of titles) {
    const rows = entries.filter((e) => e.section === section);
    if (!rows.length) continue;
    console.log(`\n${title}`);
    for (const e of rows) console.log(`  ${e.headline}${e.expires ? `  (until ${e.expires})` : ""}`);
  }
  if (!entries.length) console.log("feed: empty");
  console.error(`\nfeed: next run — ${feedDue(root, manifest.feed).reason}`);
}
