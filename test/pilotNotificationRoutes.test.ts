import { afterEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PilotChats, pilotChatTools } from "../lib/pilotChat";
import { pilotTools } from "../lib/pilot";
import { pilotChatRoutes } from "../lib/pilotChatRoutes";
import { nativeVault } from "./support/vault";
const roots: string[] = [], services: PilotChats[] = [];
afterEach(() => { services.forEach(s => s.close()); roots.forEach(r => rmSync(r, { recursive: true, force: true })); });
test("notification HTTP only permits user acknowledgments; creation is a bound Pilot tool", async () => {
  const root = nativeVault(); roots.push(root);
  const sessions = new PilotChats(root, { graph: () => [] }); services.push(sessions);
  const routes = pilotChatRoutes(sessions);
  expect(pilotChatTools().some(t => t.name === "notify_user")).toBe(true);
  expect(pilotTools().some(t => ["notify_user", "resolve_notification"].includes(t.name))).toBe(false);
  expect(routes.some(r => /notify_user|notification-create/.test(r.path as string))).toBe(false);
  const s = sessions.create([]), signal = new AbortController().signal;
  await (sessions as any).executeTool(s, "notify_user", { key: "request", kind: "question", text: "Which date?" }, signal);
  const id = sessions.notifications()[0]!.id;
  async function post(body: unknown, headers: Record<string, string>) {
    return new Promise<{ status: number; body: any }>(resolve => {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage; req.headers = headers;
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as ServerResponse;
      routes.find(r => r.path === "/api/pilot/chat/notification-state")!.handler({ req, res, url: new URL("http://localhost:4747/api/pilot/chat/notification-state") });
    });
  }
  const own = { "content-type": "application/json", host: "localhost:4747", origin: "http://localhost:4747" };
  expect((await post({ id, action: "seen" }, { ...own, origin: "https://outside.example" })).status).toBe(403);
  expect((await post({ id, action: "seen" }, { ...own, "content-type": "text/plain" })).status).toBe(415);
  expect(sessions.notifications()[0]!.seen).toBe(false);
  expect((await post({ id, action: "resolve" }, own)).status).toBe(400);
  expect((await post({ id, action: "seen" }, own)).status).toBe(200);
  expect((await post({ id, action: "dismiss" }, own)).status).toBe(200);
  expect(sessions.notifications()[0]).toMatchObject({ seen: true, dismissed: true, resolved: false });
});
