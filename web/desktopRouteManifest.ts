import { nameTask } from "../lib/pilotTaskName";
import { CodingDesktops } from "../lib/codingDesktops";
import { agentScript, agentWorkspace, webPort } from "../lib/env";
import { workspace } from "../packages/agents/src";
import { hostAgents } from "../lib/agentHost";
import { resolve } from "node:path";
import { codingDesktopRoutes } from "../lib/codingDesktopRoutes";
import { currentGraph, savedGraph } from "../lib/maintainedGraph";
import { ApplicationActions, actionReceiptView, actionHistoryQuery } from "../lib/applicationActions";
import { json, THEME_SHEET } from "../lib/httpx";
import { IntegrationAccounts } from "../lib/integrationAccounts";
import { integrationAccountRoutes } from "../lib/integrationAccountRoutes";
import { ConnectedClients } from "../lib/connectedClients";
import { connectedClientRoutes } from "../lib/connectedClientRoutes";
import { readLogRoutes } from "../lib/readLogRoutes";
import { telemetry, telemetryRoutes } from "../lib/telemetry";
import { feedbackRoutes } from "../lib/feedback";
/** Machine-local routes exposed by the desktop shell.
 *
 * Keeping this list in one place makes a missing route a compile-time review
 * concern instead of something hidden among conditional spreads in server.ts.
 */
import type { Route } from "../lib/httpx";
import { diagnosticsRoutes } from "../lib/diagnostics";
import { pilotRoutes } from "../lib/pilot";
import { PilotChats } from "../lib/pilotChat";
import { pilotChatRoutes } from "../lib/pilotChatRoutes";
import { workHistoryRoutes } from "../lib/workSessionRoutes";
import { sweepPilotSpool } from "../lib/pilotTranscript";
import { sourceOpenRoutes } from "../lib/sourceOpen";
import { themesRoutes } from "../lib/themes";
import { WorkHistory } from "../lib/workHistory";

export function desktopRouteManifest(root: string, options: { includeSupport?: boolean; actions?: ApplicationActions; changes?: import("../lib/applicationChanges").ApplicationChanges } = {}): Route[] {
  const actions = options.actions ?? new ApplicationActions(root);
  const work = new WorkHistory(root);
  const chats = new PilotChats(root, { work, actions, changes: options.changes, nameTask, graph: () => savedGraph(root)?.nodes });
  process.once("exit", () => chats.close());
  // Dev only: a scripted agent instead of the vault's model (lib/env.ts, agentScript).
  const script = agentScript();
  const desktops = new CodingDesktops(root, { nameTask, agents: hostAgents(root, workspace(agentWorkspace())), themeUrl: `http://127.0.0.1:${webPort()}${THEME_SHEET}`,
    ...(script ? { host: async () => (await import(resolve(script))).default() } : {}) });
  process.once("exit", () => desktops.close());
  // the lists serve each context source with the entities it concerns
  const graph = () => currentGraph(root);
  // Finish only already-spooled legacy speech; no endpoint accepts new turns.
  void sweepPilotSpool(root, new Date(), 0).catch(error => console.error("Legacy speech recovery:", error));
  const support = options.includeSupport === false ? [] : [
    ...diagnosticsRoutes(root),
    ...telemetryRoutes(telemetry(root)),
    ...feedbackRoutes(),
    ...themesRoutes(),
    ...sourceOpenRoutes(root),
  ];
  return [
    ...support,
    { method: "GET", path: "/api/actions", handler: ({ url, res }) => {
      try {
      const history = actions.list({ kind: "user", id: "desktop" }, actionHistoryQuery(url.searchParams));
      json(res, 200, { ...history, receipts: history.receipts.map(actionReceiptView) });
      } catch { json(res, 400, { error: "Invalid action history query." }); }
    } },
    ...pilotRoutes(root, { setPermissions: value => chats.setPermissions(value) }),
    ...pilotChatRoutes(chats, { graph }),
    ...codingDesktopRoutes(desktops, { graph }),
    ...workHistoryRoutes(work),
    ...connectedClientRoutes(new ConnectedClients(root)),
    ...integrationAccountRoutes(new IntegrationAccounts(root)),
    ...readLogRoutes(root),
  ];
}
