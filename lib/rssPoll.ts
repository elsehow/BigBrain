/**
 * rssPoll.ts — one poll of every connected feed (integrations/rss/run.ts).
 * Each feed is fetched and its new items staged (lib/integrationStage.ts):
 * the firewall screens them, then admission asks the worth gate whether the
 * gardener should see them (lib/integrationAdmission.ts).
 *
 * A feed's first poll stages only the last few days, so adding a feed never
 * floods the vault with its back catalogue; older items are marked seen. The
 * items each feed has shown are kept in .spool/rss.json, which is durable like
 * email's cursor: losing it would stage the last few days again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fsx";
import { integrationActive } from "./integrationAccess";
import { stageIntegrationContent } from "./integrationStage";
import { configuredFeeds } from "./rssConfig";
import { feedItemContent, fetchFeed } from "./rssFeed";

/** How far back a new feed's first poll reaches. */
export const FIRST_POLL_DAYS = 3;
/** Item ids remembered per feed, newest last: well past any feed's length. */
const SEEN = 1000;

interface FeedState { seen: string[]; last?: { at: string; ok: boolean; error?: string } }
export interface RssState { feeds: Record<string, FeedState> }

const statePath = (root: string) => join(root, ".spool", "rss.json");
export function readRssState(root: string): RssState {
  try {
    const v = JSON.parse(readFileSync(statePath(root), "utf8")) as RssState;
    return v && typeof v.feeds === "object" && v.feeds ? v : { feeds: {} };
  } catch { return { feeds: {} }; }
}

export async function pollRss(root: string, opts: { fetch?: typeof fetch; now?: Date } = {}): Promise<{ arrivals: number; failures: string[] }> {
  const now = opts.now ?? new Date(), state = readRssState(root);
  let arrivals = 0;
  const failures: string[] = [];
  for (const feed of configuredFeeds(root)) {
    if (!integrationActive(root, "rss", feed.url)) continue;
    const prior = state.feeds[feed.url], seen = new Set(prior?.seen ?? []);
    const since = prior ? -Infinity : now.getTime() - FIRST_POLL_DAYS * 864e5;
    try {
      const parsed = await fetchFeed(feed.url, opts.fetch);
      for (const item of parsed.items) {
        if (seen.has(item.id)) continue;
        // marked seen only once staged (or deliberately skipped), so a failed stage is retried next poll
        if (!item.date || Date.parse(item.date) >= since)
          if (await stageIntegrationContent(root, "rss", feedItemContent(feed.url, feed.title, item, now), feed.url)) arrivals++;
        seen.add(item.id);
      }
      state.feeds[feed.url] = { seen: [...seen].slice(-SEEN), last: { at: now.toISOString(), ok: true } };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failures.push(`${feed.title}: ${error}`);
      state.feeds[feed.url] = { seen: [...seen].slice(-SEEN), last: { at: now.toISOString(), ok: false, error } };
    }
    writeAtomic(statePath(root), `${JSON.stringify(state)}\n`);
  }
  return { arrivals, failures };
}
