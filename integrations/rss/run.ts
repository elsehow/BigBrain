/**
 * rss — inbound integration: follow the feeds in vault.yaml (lib/rssConfig.ts)
 * and stage what is new in them (lib/rssPoll.ts). Cadence is the supervisor's
 * table (lib/desktopSchedule.ts CADENCE).
 *
 * Usage: bun integrations/rss/run.ts
 */
import { VAULT_ROOT } from "../../lib/vaultRoot";
import { requireIntegrationEnabled } from "../../lib/integrationPoll";
import { PollError, withPollStatus } from "../../lib/integrationStatus";
import { pollRss } from "../../lib/rssPoll";

requireIntegrationEnabled("rss", VAULT_ROOT);
await withPollStatus(VAULT_ROOT, "rss", async () => {
  const { arrivals, failures } = await pollRss(VAULT_ROOT);
  console.log(`rss: ${arrivals} item(s) staged${failures.length ? ` — ${failures.join("; ")}` : ""}`);
  if (failures.length) throw new PollError(failures.join("; "));
  return { arrivals };
});
