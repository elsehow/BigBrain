import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readHistoryIndex } from "../lib/applicationHistoryIndex";
import { pilotChatDetail, pilotChatSummary } from "../lib/pilotChatSummary";
import { notePayload } from "../lib/noteRead";
import { WorkHistory } from "../lib/workHistory";
import { workDetail } from "../lib/workViews";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import { PilotChats } from "./support/pilotSession";
import { desktopRouteManifest } from "../web/desktopRouteManifest";
import { writeAtomic } from "../lib/fsx";
import { spoolDir } from "../lib/spool";
import { nativeVault } from "./support/vault";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const fixture = () => { const root = nativeVault(); roots.push(root); return root; };
const at = "2026-09-20T12:00:00.000Z";
const id = `work-${"a".repeat(32)}`;
const pilot = `pilot-${"b".repeat(32)}`;
function savedWorker(root: string) {
  const path = join(spoolDir(root), "workers", `${id}.json`);
  const record = { version: 1, id, provider: "pi", title: "Fabricated review", model: "fixture", cwd: "/sample/project",
    status: "needs-input", created: at, updated: at, receipts: [], origin: { pilot, message: "task" }, context: { nodes: [] },
    messages: [{ id: "task", role: "user", text: "Review the sample project", at }, { id: "answer", role: "agent", text: "Saved findings", at }],
    reportOutbox: [{ key: "pending-report", pilot, agent: id, kind: "question", text: "Old question", at }],
    worker: { request: { id: "pending-access", kind: "access", text: "Old approval" },
      operations: [{ id: "op", tool: "write", status: "started", at }],
      steering: [{ id: "follow-up", text: "Queued instruction", status: "queued", delivery: "steer", at }] } };
  const bytes = JSON.stringify(record); writeAtomic(path, bytes);
  return { path, bytes };
}

test("Pi workers remain readable across restarts without approvals, dispatch, or rewriting their original records", () => {
  const root = fixture(), saved = savedWorker(root);
  for (let restart = 0; restart < 2; restart++) {
    const history = new WorkHistory(root), chats = new PilotChats(root, { work: history, graph: () => [], categories: false });
    try {
      expect(history.loadIssues).toEqual([]);
      const view = workDetail(history.get(id));
      expect(view.messages.map(m => m.text)).toEqual(["Review the sample project", "Saved findings"]);
      expect(view).toMatchObject({ status: "interrupted", pending: false, worker: { archivedAt: at, operations: [{ status: "uncertain" }], steering: [{ status: "withdrawn" }] } });
      expect(view.worker?.request).toBeUndefined();
      expect(view.attention).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain("reportOutbox");
      expect(notePayload(root, `sessions/${id}.md`)).toMatchObject({ status: 200, note: { markdown: expect.stringContaining("Saved findings") } });
      expect(chats.list()).toEqual([]); // History is not converted into an executable Pilot.
      expect(readFileSync(saved.path, "utf8")).toBe(saved.bytes);
    } finally { chats.close(); }
  }
});

test("old Pilot worker reports and approval notifications cannot restart a model, leave pending cards, or be served", async () => {
  const root = fixture(), s = newPilotChatSession([], pilot, at);
  s.phase = "answered"; s.lifecycle = "ingested"; s.deactivatedAt = at;
  s.messages = [{ id: "notice-message", role: "assistant", text: "Historical access request", at }]; s.ingestedMessages = 1;
  s.pendingAgentSessionReports = ["pending-report"];
  s.workEvents = [{ key: "pending-report", work: id, title: "Old worker", kind: "question", text: "Saved question", at }];
  // Notifications were retired; an old record keeps its own, which nothing reads.
  const notifications = [{ id: "notice", pilotId: pilot, pilotTitle: s.title, messageId: "notice-message", key: "access", text: "Historical access request", kind: "update", workerRequest: `${id}:pending-access`, at, seen: false }];
  const file = join(spoolDir(root), "pilot-chats", `${pilot}.json`);
  writeAtomic(file, JSON.stringify({ ...s, notifications }));
  // A previous engine cached this as a cold archive despite its pending report.
  readHistoryIndex(root, "pilots-v3", join(spoolDir(root), "pilot-chats"), /^pilot-.*\.json$/,
    () => ({ group: "pilot", order: s.updated, summary: { view: pilotChatSummary(s), archived: true } }));
  let dispatches = 0;
  for (let restart = 0; restart < 2; restart++) {
    const chats = new PilotChats(root, { categories: false, backend: () => { dispatches++; throw new Error("Must not dispatch"); } });
    try {
      await chats.sweep(); await new Promise(resolve => setImmediate(resolve));
      expect(chats.summaries().find(v => v.id === pilot)).not.toHaveProperty("notifications"); // Check cold summaries before loading detail.
      expect(pilotChatDetail(chats.get(pilot))).not.toHaveProperty("notifications");
      expect(chats.get(pilot).messages).toEqual(s.messages);
      expect(chats.get(pilot).workEvents).toEqual(s.workEvents);
      expect(chats.get(pilot).pendingAgentSessionReports).toBeUndefined();
      expect(dispatches).toBe(0);
    } finally { chats.close(); }
  }
  expect(JSON.parse(readFileSync(file, "utf8")).notifications).toEqual(notifications);
});

test("production desktop routes expose read-only worker history and retain external-client connections", () => {
  const root = fixture(); savedWorker(root);
  const exits = new Set(process.listeners("exit"));
  try {
    const routes = desktopRouteManifest(root, { includeSupport: false });
    expect(routes.filter(r => r.path.startsWith("/api/agent-orchestration"))).toEqual([]);
    expect(routes.filter(r => r.path.startsWith("/api/pilot/work")).map(r => `${r.method} ${r.path}`)).toEqual(["GET /api/pilot/work"]);
    expect(routes.some(r => r.path === "/api/connected-clients" && r.method === "POST")).toBe(true);
    expect(routes.some(r => r.path === "/api/pilot/chat/send" && r.method === "POST")).toBe(true);
    expect(routes.filter(r => r.path.includes("notification"))).toEqual([]);
    let body = "";
    routes.find(r => r.path === "/api/pilot/work")!.handler({ url: new URL(`http://localhost/api/pilot/work?id=${id}`), res: { writeHead() {}, end(value: string) { body = value; } } } as never);
    expect(JSON.parse(body)).toMatchObject({ id, status: "interrupted", pending: false });
  } finally {
    for (const close of process.listeners("exit").filter(fn => !exits.has(fn))) { process.removeListener("exit", close); close(0); }
  }
});
