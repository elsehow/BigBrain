import { json, readBody, type Route } from "./httpx";
import { readableIntegrationAccounts } from "./integrationAccess";
import type { Projects } from "./worker/projects";
export function agentOrchestrationRoutes(projects: Projects): Route[] {
  const post = (path: string, action: (body: Record<string, unknown>) => unknown): Route => ({ method: "POST", path: `/api/agent-orchestration/${path}`, handler: async ({ req, res }) => {
    if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") return json(res, 415, { error: "JSON required." });
    if (req.headers.origin) {
      try { const origin = new URL(req.headers.origin); if (origin.protocol !== "http:" || origin.host !== req.headers.host) throw new Error(); }
      catch { return json(res, 403, { error: "The app's own origin is required." }); }
    }
    try { const body = JSON.parse(await readBody(req, 24_000)); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected an object."); json(res, 200, action(body)); }
    catch (e) { json(res, 400, { error: e instanceof Error ? e.message : "Could not update project access." }); }
  } });
  return [
    { method: "GET", path: "/api/agent-orchestration", handler: ({ res }) => json(res, 200, { projects: projects.list(), accounts: ["email", "granola"].flatMap(integration => readableIntegrationAccounts(projects.root, integration, { kind: "pilot" }).map(account => ({ integration, account }))) }) },
    post("inspect", body => projects.inspect(String(body.path))),
    post("credentials", body => projects.connect(String(body.path), body.values)),
    post("save", body => projects.save(body)), post("remove", body => { projects.remove(body.id); return { ok: true }; }),
  ];
}
