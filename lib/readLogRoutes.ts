/** Settings' read-only view of the read log (lib/readLog.ts): an account's
 * recent reads, and when each caller last read. Behind the viewer session,
 * like every route the viewer serves. */
import { json, type Route } from "./httpx";
import { integrationNamed } from "./integrations";
import { lastReads, recentReads } from "./readLog";

export function readLogRoutes(root: string): Route[] {
  return [
    { method: "GET", path: "/api/integration-reads", handler: ({ url, res }) => {
      const integration = url.searchParams.get("integration") ?? "", account = url.searchParams.get("account") ?? "";
      if (!integrationNamed(integration) || !account || account.length > 512) return json(res, 400, { error: "Choose an integration account." });
      json(res, 200, { reads: recentReads(root, integration, account) });
    } },
    { method: "GET", path: "/api/integration-reads/callers", handler: ({ res }) => {
      json(res, 200, { callers: Object.fromEntries([...lastReads(root)].map(([caller, last]) => [caller, { ...last, name: integrationNamed(last.integration)?.name ?? last.integration }])) });
    } },
  ];
}
