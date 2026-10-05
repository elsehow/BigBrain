import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { IntegrationAccounts } from "../lib/integrationAccounts";
import { accountFingerprint, accountPolicy, integrationActive, writeAccountPolicy } from "../lib/integrationAccess";
import { loadManifest } from "../lib/manifest";
import { rssFeeds } from "../lib/rssConfig";
import { parseFeed } from "../lib/rssFeed";
import { pollRss, readRssState } from "../lib/rssPoll";
import { stagedItems } from "../lib/stageStorage";
import { gitVault } from "./support/vault";

// All content here is invented.
const rss = (items: { guid: string; title: string; date: string }[]) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Orrery &amp; Co. News</title>
${items.map((i) => `<item><title><![CDATA[${i.title}]]></title><link>https://news.example/${i.guid}</link><guid>${i.guid}</guid>
<pubDate>${new Date(i.date).toUTCString()}</pubDate><description>&lt;p&gt;Briar &amp;amp; Kit report on ${i.title}.&lt;/p&gt;</description></item>`).join("\n")}
</channel></rss>`;

describe("reading a feed", () => {
  test("RSS: CDATA titles, escaped HTML summaries as plain text, links, guids and dates", () => {
    const f = parseFeed(rss([{ guid: "a1", title: "The orrery is repaired", date: "2026-10-01T09:00:00Z" }]));
    expect(f.title).toBe("Orrery & Co. News");
    expect(f.items).toEqual([{ id: "a1", title: "The orrery is repaired", link: "https://news.example/a1", date: "2026-10-01T09:00:00.000Z", summary: "Briar & Kit report on The orrery is repaired." }]);
  });

  test("Atom: entries, the alternate link, and published dates", () => {
    const f = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Atlas log</title>
      <entry><title>Week 40</title><id>urn:atlas:40</id><link rel="self" href="https://atlas.example/self"/><link href="https://atlas.example/40"/>
      <published>2026-10-02T10:00:00Z</published><summary type="html">&lt;b&gt;Survey&lt;/b&gt; finished</summary></entry></feed>`);
    expect(f).toEqual({ title: "Atlas log", items: [{ id: "urn:atlas:40", title: "Week 40", link: "https://atlas.example/40", date: "2026-10-02T10:00:00.000Z", summary: "Survey finished" }] });
  });

  test("a page that isn't a feed is refused", () => {
    expect(() => parseFeed("<html><body>Hello</body></html>")).toThrow("isn't an RSS or Atom feed");
  });
});

describe("the RSS integration", () => {
  test("a feed is added by reading it; polls stage the last few days first, then only what's new; a disconnected feed rests", async () => {
    const root = gitVault({ files: { "vault.yaml": "integrations: {}\n" } });
    try {
      let items = [
        { guid: "old", title: "Last month's repair", date: "2026-09-01T09:00:00Z" },
        { guid: "new", title: "This week's survey", date: "2026-10-04T09:00:00Z" },
      ];
      const fetch = (async () => new Response(rss(items))) as unknown as typeof globalThis.fetch;
      const url = "https://news.example/feed.xml";
      const accounts = new IntegrationAccounts(root, { rss: async (u) => parseFeed(await (await fetch(u)).text()) });
      await expect(accounts.update({ name: "rss", action: "add", url: "ftp://news.example/feed" })).rejects.toThrow("https://");
      const listed = await accounts.update({ name: "rss", action: "add", url });
      expect(listed.accounts.find((a) => a.name === "rss")).toMatchObject({ account: url, label: "Orrery & Co. News", connected: true, removable: true });
      expect(rssFeeds(loadManifest(root).integrations.rss)).toEqual([{ url, title: "Orrery & Co. News" }]);
      expect(integrationActive(root, "rss", url)).toBe(true);
      await expect(accounts.update({ name: "rss", action: "add", url })).rejects.toThrow("already listed");

      const now = new Date("2026-10-05T12:00:00Z");
      expect(await pollRss(root, { fetch, now })).toEqual({ arrivals: 1, failures: [] }); // last month's is seen, not staged
      expect(stagedItems(root, "rss").map((s) => s.content)).toEqual([expect.stringContaining("This week's survey")]);
      expect(readRssState(root).feeds[url]!.seen).toEqual(["old", "new"]);

      items = [...items, { guid: "newer", title: "Kit's note", date: "2026-10-05T10:00:00Z" }];
      expect(await pollRss(root, { fetch, now })).toEqual({ arrivals: 1, failures: [] });
      expect(await pollRss(root, { fetch, now })).toEqual({ arrivals: 0, failures: [] });

      writeAccountPolicy(root, "rss", url, { ...accountPolicy(root, "rss", url), connected: false });
      items = [...items, { guid: "newest", title: "Unread", date: "2026-10-05T11:00:00Z" }];
      expect(await pollRss(root, { fetch, now })).toEqual({ arrivals: 0, failures: [] });

      const removed = await accounts.update({ name: "rss", account: url, action: "remove" });
      expect(removed.accounts.some((a) => a.name === "rss")).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a feed that fails says so, and keeps what it had seen", async () => {
    const root = gitVault({ files: { "vault.yaml": "integrations:\n  rss:\n    feeds:\n      - url: https://down.example/feed.xml\n        title: Down\n" } });
    try {
      const url = "https://down.example/feed.xml";
      writeAccountPolicy(root, "rss", url, { ...accountPolicy(root, "rss", url), connected: true, fingerprint: accountFingerprint(root, "rss", url) });
      const fetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof globalThis.fetch;
      expect(await pollRss(root, { fetch })).toEqual({ arrivals: 0, failures: ["Down: down.example answered 503."] });
      expect(readRssState(root).feeds[url]).toMatchObject({ seen: [], last: { ok: false, error: "down.example answered 503." } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
