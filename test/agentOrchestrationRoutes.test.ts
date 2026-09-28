import { ApplicationActions } from "../lib/applicationActions";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { workHistoryRoutes } from '../lib/workSessionRoutes';
import type { AgentOrchestrator } from '../lib/agentOrchestrator';
import type { WorkHistory } from '../lib/workHistory';

test('agent session actions reject foreign origins and form submissions before touching the runtime', async () => {
  const opened: unknown[] = [];
  const routes = workHistoryRoutes({} as WorkHistory, { interrupt: async (id: unknown) => { opened.push(id); return { id: "fixture", title: "Test task", status: "interrupted", provider: "pi", cwd: "", context: {}, messages: [], receipts: [], created: "2026-09-01", updated: "2026-09-01" }; } } as AgentOrchestrator);
  const route = routes.find(r => r.path.endsWith('/stop'))!;
  const call = async (headers: Record<string, string>, body = '{"id":"fixture"}') => {
    const req = Object.assign(new PassThrough(), { headers: { host: 'localhost:4747', ...headers } });
    let status = 0, result: unknown;
    const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { result = JSON.parse(text); } };
    const done = route.handler({ req, res, url: new URL('http://localhost:4747/api/pilot/work/stop') } as never);
    req.end(body); await done;
    return { status, result };
  };
  expect((await call({'content-type':'text/plain'})).status).toBe(415);
  expect((await call({'content-type':'application/json',origin:'https://untrusted.example'})).status).toBe(403);
  expect((await call({'content-type':'application/json'},'[]')).status).toBe(400);
  expect(opened).toEqual([]);
  expect((await call({'content-type':'application/json',origin:'http://localhost:4747'})).status).toBe(200);
  expect(opened).toEqual(['fixture']);
  expect(routes.some(r => r.path.endsWith('/respond'))).toBe(false);
});

test("desktop follow-up deliveries share application receipts and cannot borrow Pilot identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "work-action-route-"));
  try {
    const actions = new ApplicationActions(root); let writes = 0, revoked = false;
    const external = { validateMessage() {}, authorizeAction() { if (revoked) throw new Error("Revoked"); }, async message() {
      writes++; return { id: "fixture", title: "Task", status: "working", provider: "pi", cwd: "", context: {}, messages: [], receipts: [], created: "2026-09-01", updated: "2026-09-01" };
    } } as unknown as AgentOrchestrator;
    const route = workHistoryRoutes({} as WorkHistory, external, actions).find(r => r.path.endsWith("/send"))!;
    const call = async (text = "Continue") => {
      const req = Object.assign(new PassThrough(), { headers: { host: "localhost:4747", origin: "http://localhost:4747", "content-type": "application/json" } });
      let status = 0;
      const res = { writeHead(code: number) { status = code; }, end() {} };
      const done = route.handler({ req, res, url: new URL("http://localhost:4747/api/pilot/work/send") } as never);
      req.end(JSON.stringify({ id: "fixture", text, actionId: "delivery-id", actor: { kind: "pilot", id: "forged" } })); await done; return status;
    };
    expect(await call()).toBe(200); expect(await call()).toBe(200); expect(writes).toBe(1);
    expect(await call("Different")).toBe(400); expect(writes).toBe(1);
    expect(actions.list({ kind: "user", id: "desktop" }).receipts[0]).toMatchObject({ operation: "message_agent", status: "completed" });
    expect(actions.list({ kind: "pilot", id: "forged" }).receipts).toHaveLength(0);
    revoked = true; expect(await call()).toBe(400); expect(writes).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
