/** Pilots-only experiment: isolated session storage, live graph APIs via :4747. */
import { nameTask } from "../lib/pilotTaskName";
import { createServer, request } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vaultOverride, pilotDevContextRoot, pilotDevPort, pilotDevUiPort } from "../lib/env";
import { requireVaultRoot } from "../lib/engine";
import { PilotChats } from "../lib/pilotChat";
import { pilotChatRoutes } from "../lib/pilotChatRoutes";
import { pilotRoutes } from "../lib/pilot";
import { WorkHistory } from "../lib/workHistory";
import { allowLoopbackRequest, armor, dispatch, json, readBody, send, type Route } from "../lib/httpx";
import { loadManifest } from "../lib/manifest";
import { configSave, integrationsInfo } from "../lib/configWrite";
import { pilotModels } from "../lib/modelCatalog";
if (!vaultOverride()) throw new Error("Set BIGBRAIN_VAULT to an isolated dev vault before starting pilot:dev.");
const backendPort = pilotDevPort();
const uiPort = pilotDevUiPort();
const contextRoot = pilotDevContextRoot();
const root = requireVaultRoot();
// Session-only scratch vaults still need a manifest for the Settings routes.
const manifestPath = join(root, "vault.yaml");
if (!existsSync(manifestPath)) writeFileSync(manifestPath, "integrations: {}\n", { flag: "wx" });
loadManifest(root); // Fail before launching the UI if an existing manifest is invalid.
const workers = new WorkHistory(root), chats = new PilotChats(root, { work: workers, contextRoot, nameTask });
const routes: Route[] = [...pilotChatRoutes(chats), ...pilotRoutes(root, { setPermissions: value => chats.setPermissions(value) }),
  { method: "GET", path: "/api/agents/models", handler: ({ res }) => {
    // Connection controls are proxied to the real vault; use that same consent
    // state for the model picker, not the isolated chat-storage directory.
    void pilotModels(contextRoot ?? root).then(agents => json(res, 200, { agents })).catch(() => json(res, 503, { error: "Could not load agent sessions." }));
  } },
  { method: "GET", path: "/api/config", handler: ({ res }) => {
    const m = loadManifest(root);
    json(res, 200, { integrations: integrationsInfo(root, m), curation: m.curation ?? null, gardener: m.gardener,
      memory: { ...m.memory, interval: m.memory.intervalMs }, quick: m.quick });
  } },
  { method: "POST", path: "/api/config", handler: ({ req, res }) => {
    void readBody(req).then(body => configSave(root, body)).then(r => send(res, r.status, r.body))
      .catch(() => json(res, 400, { error: "Could not save configuration." }));
  } },
];
let vite: ReturnType<typeof Bun.spawn> | undefined;
const server = createServer((req, res) => {
  armor(res);
  if (!allowLoopbackRequest(req, res)) return;
  if (requireVaultRoot() !== root) {
    json(res, 409, { error: "The selected vault changed. Restart pilot:dev before using Pilot with the new vault." }); return;
  }
  try { if (dispatch(routes, req, res)) return; }
  catch (e) {
    console.error("Pilot dev request failed:", e instanceof Error ? e.message : String(e));
    if (!res.headersSent) json(res, 500, { error: "The dev engine could not handle this request. Check its configuration." });
    else res.end();
    return;
  }
  const upstream = request({ hostname: "127.0.0.1", port: 4747, method: req.method, path: req.url, headers: req.headers }, incoming => {
    res.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Installed BigBrain backend is unavailable on :4747."); });
  req.pipe(upstream);
});
let closing = false;
function close() { if (closing) return; closing = true; vite?.kill(); chats.close(); server.close(() => process.exit()); }
process.on("SIGINT", close); process.on("SIGTERM", close);
server.on("error", e => { console.error(e.message); close(); process.exitCode = 1; });
server.listen(backendPort, "127.0.0.1", () => {
  console.log(`Pilots-only backend :${backendPort} · vault ${root} · context ${contextRoot ?? root} · other APIs :4747`);
  if (process.argv.includes("--backend-only")) return;
  vite = Bun.spawn(["bun", "run", "dev", "--host", "127.0.0.1", "--port", String(uiPort), "--strictPort"], {
    cwd: new URL("../web/ui", import.meta.url).pathname,
    env: { ...process.env, BIGBRAIN_WEB_PORT: String(backendPort) }, stdout: "inherit", stderr: "inherit",
  });
  void vite.exited.then(close);
});
