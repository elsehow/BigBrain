/**
 * codingDesktopRoutes.ts — `/api/desktops/*`, v2's coding desktops
 * (lib/codingDesktops.ts). Same rules as Pilot's routes: JSON bodies, and
 * the app's own origin only.
 */
import { AgentsError } from "../packages/agents/src";
import { CodingDesktopError, type CodingDesktops } from "./codingDesktops";
import { json, readBody, THEME_SHEET, type Route } from "./httpx";
import { withContextSourcesOf } from "./contextSources";
import type { Graph } from "./graph";

const message = (e: unknown) => e instanceof CodingDesktopError || e instanceof AgentsError ? e.message : "Could not update the desktop.";
const status = (e: unknown) => e instanceof CodingDesktopError ? e.status : e instanceof AgentsError ? 400 : 500;

/** `graph`, as for Pilot's list: each context source with the entities it concerns. */
export function codingDesktopRoutes(desktops: CodingDesktops, options: { graph?: () => Promise<Graph> } = {}): Route[] {
  const post = (path: string, fn: (body: Record<string, unknown>) => unknown): Route => ({ method: "POST", path: `/api/desktops/${path}`, handler: ({ req, res }) => {
    if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") return json(res, 415, { error: "JSON required." });
    if (req.headers.origin) {
      try { const origin = new URL(req.headers.origin); if (origin.host !== req.headers.host || origin.protocol !== "http:") throw new Error(); }
      catch { return json(res, 403, { error: "The app's own origin is required." }); }
    }
    void readBody(req, 150_000).then(raw => {
      const body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new CodingDesktopError("Expected an object.");
      return fn(body);
    }).then(result => json(res, 200, result ?? { ok: true })).catch(e => json(res, status(e), { error: message(e) }));
  } });
  const get = (path: string, fn: (url: URL) => unknown): Route => ({ method: "GET", path: `/api/desktops${path}`, handler: ({ url, res }) => {
    void Promise.resolve().then(() => fn(url)).then(result => json(res, 200, result)).catch(e => json(res, status(e), { error: message(e) }));
  } });
  return [
    get("", async () => ({ desktops: await withContextSourcesOf(desktops.list(), options.graph) })),
    get("/session", url => desktops.detail(url.searchParams.get("id"))),
    get("/diff", url => desktops.diff(url.searchParams.get("id"), url.searchParams.get("project"))),
    get("/network", () => desktops.network()),
    { method: "GET", path: "/api/desktops/events", handler: ({ req, url, res }) => {
      try { desktops.stream(url.searchParams.get("id"), Number(url.searchParams.get("since")) || 0, res, fn => req.on("close", fn)); }
      catch (e) { json(res, status(e), { error: message(e) }); }
    } },
    // linked from pages agents serve on other loopback ports (allowLoopbackRequest lets them); only colours and fonts
    { method: "GET", path: THEME_SHEET, handler: ({ res }) => {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" });
      res.end(desktops.theme());
    } },
    post("create", b => desktops.create(b)),
    post("send", b => desktops.send(b.id, b.text, b.inputId)),
    post("steer", b => desktops.steer(b.id, b.text, b.inputId)),
    post("stop", b => desktops.stop(b.id)),
    post("archive", b => desktops.archive(b.id)),
    post("allow-shell", b => desktops.allowShell(b.id)),
    post("rename", b => desktops.rename(b.id, b.title)),
    post("model", b => desktops.setModel(b.id, b.model)),
    post("land", b => desktops.land(b.id, b.project, b.how, b.head)),
    post("network", b => desktops.setNetwork(b.hosts)),
    post("discard", b => desktops.discard(b.id, b.project)),
    post("view", b => desktops.view(b.id, b.action, b)),
    post("theme", b => desktops.writeTheme(b.css)),
  ];
}
