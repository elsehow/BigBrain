/**
 * rssConfig.ts — the RSS integration's feeds. A feed is public, so it lives in
 * vault.yaml, where it can be read and committed:
 *
 *   integrations:
 *     rss:
 *       feeds:
 *         - url: https://example.com/feed.xml
 *           title: Example news
 *
 * Each feed is one account (lib/integrationAccess.ts): connected when it was
 * last fetched and read as a feed, and remembered while connected. Adding and
 * removing a feed goes through the settings screen (lib/integrationAccounts.ts).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { writeAtomic } from "./fsx";
import { commitAs } from "./git";
import { loadManifest } from "./manifest";

export interface RssFeed { url: string; title: string }

/** A feed address: http(s) only, normalized; anything else throws in the form's words. */
export function feedUrl(raw: unknown): string {
  let url: URL;
  try { url = new URL(String(raw ?? "").trim()); } catch { throw new Error("Enter the feed's address, starting with https://"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("A feed address starts with https:// or http://");
  return url.href;
}

/** The configured feeds, read tolerantly: malformed and repeated entries drop. */
export function rssFeeds(block: unknown): RssFeed[] {
  const raw = (block as { feeds?: unknown } | undefined)?.feeds;
  if (!Array.isArray(raw)) return [];
  const out: RssFeed[] = [];
  for (const f of raw) {
    let url: string;
    try { url = feedUrl((f as { url?: unknown })?.url); } catch { continue; }
    if (out.some((o) => o.url === url)) continue;
    const title = (f as { title?: unknown }).title;
    out.push({ url, title: typeof title === "string" && title.trim() ? title.trim() : new URL(url).host });
  }
  return out;
}

/** This vault's feeds. */
export const configuredFeeds = (root: string): RssFeed[] => rssFeeds(loadManifest(root).integrations.rss);

/** Rewrite the feed list in vault.yaml and commit it. */
export function writeFeeds(root: string, feeds: RssFeed[], message: string): void {
  const path = join(root, "vault.yaml");
  const doc = parseDocument(readFileSync(path, "utf8"));
  doc.setIn(["integrations", "rss", "feeds"], doc.createNode(feeds));
  writeAtomic(path, String(doc));
  commitAs(root, "config", message, ["vault.yaml"]);
}
