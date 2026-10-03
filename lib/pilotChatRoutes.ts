import { actionHistoryQuery } from "./applicationActions";
import { notificationView } from "./publicViews";
import { json, readBody, type Route } from "./httpx";
import { pilotChatDetail } from "./pilotChatSummary";
import { PilotError } from "./pilot";
import { PilotChats } from "./pilotChat";

export function pilotChatRoutes(sessions: PilotChats): Route[] {
  sessions.startMaintenance();
  const post = (path: string, fn: (body: Record<string, unknown>) => unknown): Route => ({ method: "POST", path: `/api/pilot/chat/${path}`, handler: ({ req, res }) => {
    if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") return json(res, 415, { error: "JSON required." });
    if (req.headers.origin) {
      try { const origin = new URL(req.headers.origin); if (origin.host !== req.headers.host || origin.protocol !== "http:") throw new Error(); }
      catch { return json(res, 403, { error: "The app's own origin is required." }); }
    }
    void readBody(req, path === "image" ? 7_100_000 : 150_000).then(raw => {
      const body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new PilotError("Expected an object.");
      return fn(body);
    }).then(result => json(res, 200, result && typeof result === "object" && "messages" in result && "phase" in result ? pilotChatDetail(result as import("./pilotChatTypes").PilotChatSession) : result)).catch(e => json(res, e instanceof PilotError ? e.status : 400, { error: e instanceof PilotError ? e.message : "Could not update the Pilot session." }));
  } });
  return [
    { method: "GET", path: "/api/pilot/chat/actions", handler: ({ url, res }) => {
      try { json(res, 200, sessions.actionReceipts(url.searchParams.get("id"), actionHistoryQuery(url.searchParams))); }
      catch { json(res, 404, { error: "Pilot conversation is unavailable." }); }
    } },
    { method: "GET", path: "/api/pilot/chat/image", handler: ({ url, res }) => {
      try { const { bytes, mime } = sessions.image(url.searchParams.get("id")); res.writeHead(200, { "Content-Type": mime, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" }); res.end(bytes); }
      catch { json(res, 404, { error: "Image unavailable." }); }
    } },
    { method: "GET", path: "/api/pilot/chat/models", handler: async ({ res }) => {
      try { json(res, 200, { agents: await sessions.models() }); }
      catch { json(res, 503, { error: "Could not load Pilot models." }); }
    } },
    post("image", b => sessions.uploadImage(b.data, b.name)),
    { method: "GET", path: "/api/pilot/chat", handler: ({ url, res }) => json(res, 200, { sessions: sessions.summaries(url.searchParams.get("query") ?? "", url.searchParams.has("ids") ? url.searchParams.get("ids")!.split(",") : undefined), issues: sessions.loadIssues }) },
    { method: "GET", path: "/api/pilot/chat/session", handler: ({ url, res }) => {
      try { json(res, 200, pilotChatDetail(sessions.get(url.searchParams.get("id")))); }
      catch { json(res, 404, { error: "Pilot conversation is unavailable." }); }
    } },
    { method: "GET", path: "/api/pilot/chat/backend", handler: ({ res }) => json(res, 200, sessions.defaultBackend()) },
    { method: "GET", path: "/api/pilot/chat/notifications", handler: ({ res }) => json(res, 200, { notifications: sessions.notifications().map(notificationView) }) },
    post("notification-state", b => sessions.notificationState(b.id, b.action)),
    post("create", b => sessions.create(b.context, b.id)),
    post("presence", b => { sessions.presence(b.client, b.id); return { ok: true }; }),
    post("check", () => sessions.check()),
    post("draft", b => sessions.draft(b.id, b.text, b.images)),
    post("discard", b => { sessions.discard(b.id); return { ok: true }; }),
    post("send", b => sessions.submit(b.id, b.text, { id: typeof b.inputId === "string" ? b.inputId : crypto.randomUUID(), mode: b.mode === "voice" ? "voice" : "text", images: b.images as import("./chatImageTypes").ChatImage[] | undefined, ...(typeof b.target === "string" ? { target: b.target } : {}), ...(b.notificationId !== undefined ? { notificationId: b.notificationId as string } : {}) })),
    post("spoken", b => sessions.recordSpoken(b.id, b.receipt)),
    post("backend", b => b.id ? sessions.setBackend(b.id, b.backend) : sessions.setDefaultBackend(b.backend)),
    post("deactivate", b => sessions.stopTree(b.id)),
    post("stop-tree", b => sessions.stopTree(b.id, b.confirmed)),
    post("stop", b => sessions.stop(b.id)),
    post("resume", b => sessions.resumeInputs(b.id)),
    post("context", b => sessions.setContext(b.id, b.nodes, b.title, b.expectedRevision)),
    post("rename", b => sessions.rename(b.id, b.title)),
    post("desktop", b => sessions.desktop(b.id, b.action, b)),
    post("context-add", b => sessions.addContext(b.id, b.nodes)),
  ];
}
