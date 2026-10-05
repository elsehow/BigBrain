/**
 * rssFeed.ts — what an RSS or Atom feed says, read with no model (the RSS
 * integration, integrations/rss/run.ts); `fetchFeed` is its one network call. Each item becomes the
 * discussable version of an arrival: its headline, the feed's own summary as
 * plain text, and the link. Fetching the full article is not attempted: many
 * feeds (news especially) are paywalled, and the summary is what they offer.
 */

import { serializeEnvelope } from "./envelope";
import { sha256hex } from "./hash";

export interface FeedItem {
  /** Stable within the feed: the guid or id, else the link, else title and date. */
  id: string;
  title: string;
  link?: string;
  /** ISO 8601, when the feed gives a date it can read. */
  date?: string;
  summary: string;
}

export interface Feed { title: string; items: FeedItem[] }

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m);

const cdata = (s: string): string => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

/** HTML as plain text: scripts and tags dropped, blocks become line breaks.
 * Feeds often escape their HTML (`&lt;p&gt;`), so escaped markup is unescaped first. */
export function htmlText(raw: string): string {
  const html = /<[a-z!/]/i.test(raw) ? raw : decode(raw);
  return decode(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|blockquote)>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? cdata(m[1]!).trim() : undefined;
};

const iso = (raw: string | undefined): string | undefined => {
  const t = raw ? Date.parse(raw.trim()) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

/** An Atom entry's link: rel="alternate", or the first with no rel. */
function atomLink(entry: string): string | undefined {
  for (const m of entry.matchAll(/<link\b([^>]*?)\/?>/gi)) {
    const attrs = m[1]!, href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1], rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (href && (!rel || rel === "alternate")) return decode(href);
  }
  return undefined;
}

const MAX_SUMMARY = 20_000;

/** Parse RSS 2.0 (`<item>`) or Atom (`<entry>`). A document that is neither throws. */
export function parseFeed(xml: string): Feed {
  const atom = /<feed\b/i.test(xml) && !/<rss\b|<channel\b/i.test(xml);
  const blocks = [...xml.matchAll(atom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  if (!blocks.length && !/<(rss|feed|channel)\b/i.test(xml)) throw new Error("This address isn't an RSS or Atom feed.");
  const first = xml.search(atom ? /<entry\b/i : /<item\b/i), head = first > 0 ? xml.slice(0, first) : xml;
  const items = blocks.map((b): FeedItem => {
    const title = htmlText(tag(b, "title") ?? "") || "(untitled)";
    const link = atom ? atomLink(b) : (tag(b, "link") ? decode(tag(b, "link")!) : undefined);
    const date = iso(atom ? tag(b, "published") ?? tag(b, "updated") : tag(b, "pubDate") ?? tag(b, "dc:date"));
    const body = atom ? tag(b, "content") ?? tag(b, "summary") : tag(b, "content:encoded") ?? tag(b, "description");
    const id = (atom ? tag(b, "id") : tag(b, "guid")) || link || `${title}\n${date ?? ""}`;
    return { id: decode(id), title, ...(link ? { link } : {}), ...(date ? { date } : {}), summary: htmlText(body ?? "").slice(0, MAX_SUMMARY) };
  });
  return { title: htmlText(tag(head, "title") ?? "") || "Feed", items };
}

/** One item as it is staged: the headline, the summary and the link, with
 * the arrival identity (stream = the feed, key = the item) the engine reads. */
export function feedItemContent(feedUrl: string, feedTitle: string, item: FeedItem, now = new Date()): string {
  return serializeEnvelope({
    id: `rss-${sha256hex(`${feedUrl}\n${item.id}`).slice(0, 24)}`,
    source: "rss", kind: "article", title: item.title, ...(item.link ? { url: item.link } : {}),
    date: item.date ?? now.toISOString(), from: feedTitle, stream: `rss:${feedUrl}`, key: item.id,
  }, [item.summary, item.link].filter(Boolean).join("\n\n"));
}

/** Fetch and parse a feed. A slow, failing or non-feed address throws in words the settings form can show. */
export async function fetchFeed(url: string, fetchImpl: typeof fetch = fetch): Promise<Feed> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5", "user-agent": "BigBrain (+https://bigbrain.cool)" },
      redirect: "follow", signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`Couldn't reach ${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}.`);
  return parseFeed(await res.text());
}
