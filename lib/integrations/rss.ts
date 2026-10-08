/** RSS and Atom feeds: each feed in vault.yaml is an account (lib/rssConfig.ts).
 * Public, so there is no credential, and no live tools. */
import { configuredFeeds } from "../rssConfig";
import { sha256hex } from "../hash";
import type { Integration } from "./contract";

export const rss: Integration = {
  id: "rss",
  name: "RSS feeds",
  library: { description: "Follow news and blogs; what matters reaches your feed.", added: root => configuredFeeds(root).length > 0 },
  origin: "rss",
  credential: { kind: "none" },
  accounts: root => configuredFeeds(root).map(f => f.url),
  // public: no secret to change
  fingerprint: (_root, account) => sha256hex(JSON.stringify([account])),
  tools: [],
};
