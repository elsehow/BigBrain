/** Isolated profiling server. Only mounts local read routes; no model routes. */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createServer } from "node:http";
import { dispatch } from "../../lib/httpx";
const [root, port = "53917"] = process.argv.slice(2);
if (!root || !/^bb-(vault-scale|gardener-profile)-/.test(basename(root)) || !existsSync(join(root, ".benchmark-snapshot"))) throw new Error("Marked snapshot required");
if (process.env.BIGBRAIN_ASSERTION_DB || process.env.BIGBRAIN_SEARCH_DB) throw new Error("External database override forbidden");
process.env.BIGBRAIN_VAULT = root;
delete process.env.BIGBRAIN_DESKTOP;
delete process.env.BIGBRAIN_DEV;
const { ROUTES } = await import("../../web/server");
const allowed = new Set(["/", "/assets/*", "/api/vault", "/api/notes", "/api/note", "/api/recent", "/api/search", "/api/graph", "/api/config"]);
const routes = ROUTES.filter(r => r.method === "GET" && allowed.has(r.path));
createServer((req, res) => {
  try {
    if (dispatch(routes, req, res)) return;
    res.writeHead(req.method === "GET" ? 404 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Disabled during local profiling" }));
  } catch {
    res.writeHead(500); res.end("Profiling route failed");
  }
}).listen(Number(port), "127.0.0.1", () => console.error(`Snapshot profiler listening on ${port}`));
