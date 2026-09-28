import { ApplicationActions, userActionId } from "./applicationActions";
import { json, readBody, type Route } from "./httpx";
import { workDetail, type WorkSession, type WorkHistory } from "./workHistory";
import type { AgentOrchestrator } from "./agentOrchestrator";
export function workHistoryRoutes(history: WorkHistory, external?: AgentOrchestrator, actions?: ApplicationActions): Route[] {
  const post = (path: string, fn: (body: Record<string, unknown>) => Promise<unknown>): Route => ({ method: "POST", path: `/api/pilot/work/${path}`, handler: async ({ req, res }) => {
    if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") return json(res, 415, { error: "JSON required." });
    if (req.headers.origin) {
      try { const origin = new URL(req.headers.origin); if (origin.protocol !== "http:" || origin.host !== req.headers.host) throw new Error(); }
      catch { return json(res, 403, { error: "The app's own origin is required." }); }
    }
    try {
      const body = JSON.parse(await readBody(req, 40_000));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected an object.");
      json(res, 200, workDetail(await fn(body) as WorkSession));
    } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : "Could not update the agent." }); }
  } });
  return [{ method: "GET", path: "/api/pilot/work", handler: ({ url, res }) => {
    try { const id = url.searchParams.get("id"); json(res, 200, id ? workDetail(external?.has(id) ? external.get(id) : history.get(id)) : { sessions: [...history.list(), ...(external?.list() ?? [])].filter(s => !url.searchParams.has("ids") || url.searchParams.get("ids")!.split(",").includes(s.id)), issues: [...history.loadIssues, ...(external?.loadIssues ?? [])] }); }
    catch (error) { json(res, 404, { error: error instanceof Error ? error.message : "Historical session not found" }); }
  } }, ...(external ? [
    post("approve", async b => external.approve(b.id, b.request, b.allow, b.remember, b.environment)),
    post("answer", async b => external.userAnswer(b.id, b.request, b.text)),
    post("stop", async b => external.interrupt(b.id)),
    post("send", async b => actions ? actions.execute({ actor: { kind: "user", id: "desktop" }, request: userActionId(b.actionId),
      operation: "message_agent", scope: [String(b.id)], payload: { id: b.id, text: b.text } },
      { authorize: () => external.authorizeAction(b.id), validate: () => external.validateMessage(b.id, b.text), execute: () => external.message(b.id, b.text) }) : external.message(b.id, b.text)),
  ] : [])];
}
