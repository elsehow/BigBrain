import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { nativeVault } from "./support/vault";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import { PilotChats } from "./support/pilotSession";
import { desktopRouteManifest } from "../web/desktopRouteManifest";
import { writeAtomic } from "../lib/fsx";
import { spoolDir } from "../lib/spool";
import { setPilotKey } from "../lib/pilot";

const roots: string[] = [];
const open: PilotChats[] = [];
afterEach(() => { open.splice(0).forEach(c => c.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
function fixture() {
  const root = nativeVault(); roots.push(root);
  const a = newPilotChatSession([], `pilot-${"a".repeat(32)}`, "2026-09-20T12:00:00.000Z");
  const b = newPilotChatSession([], `pilot-${"b".repeat(32)}`, "2026-09-10T12:00:00.000Z");
  for (const s of [a, b]) {
    s.title = s.id; s.phase = "answered"; s.backend = { adapter: "pi", provider: "openai", model: "gpt-5.6-terra" };
    writeAtomic(join(spoolDir(root), "pilot-chats", `${s.id}.json`), JSON.stringify(s));
  }
  return { root, a, b, path: (id: string) => join(spoolDir(root), "pilot-chats", `${id}.json`) };
}
function load(root: string) { const chats = new PilotChats(root, { graph: () => [] }); open.push(chats); return chats; }
async function desktopHistory(root: string) {
  const exits = new Set(process.listeners("exit"));
  try {
    const routes = desktopRouteManifest(root, { includeSupport: false });
    // the list reads the graph before it answers
    const body = await new Promise<string>(end => routes.find(r => r.path === "/api/pilot/chat" && r.method === "GET")!
      .handler({ url: new URL("http://localhost/api/pilot/chat"), res: { writeHead() {}, end } } as never));
    return JSON.parse(body);
  } finally {
    // Release only this manifest's exit-owned runtime before removing its scratch vault.
    for (const close of process.listeners("exit").filter(fn => !exits.has(fn))) { process.removeListener("exit", close); close(0); }
  }
}

test("two restarts preserve activity ordering and persist recovery before exposing history", () => {
  const f = fixture(); f.a.phase = "working";
  writeAtomic(f.path(f.a.id), JSON.stringify(f.a));
  const first = load(f.root);
  expect(first.list().map(s => s.id)).toEqual([f.a.id, f.b.id]);
  expect(first.get(f.a.id).phase).toBe("interrupted");
  expect(first.get(f.a.id).updated).toBe(f.a.updated);
  const saved = readFileSync(f.path(f.a.id), "utf8"), untouched = readFileSync(f.path(f.b.id), "utf8");
  expect(JSON.parse(saved).phase).toBe("interrupted");
  first.close();
  const second = load(f.root);
  expect(second.list().map(s => s.id)).toEqual([f.a.id, f.b.id]);
  expect(readFileSync(f.path(f.a.id), "utf8")).toBe(saved);
  expect(readFileSync(f.path(f.b.id), "utf8")).toBe(untouched);
});

test("desktop routes remain available with damaged Pilot, provider, worker and research records", async () => {
  const f = fixture();
  writeAtomic(f.path(f.b.id), "{broken");
  writeAtomic(join(spoolDir(f.root), "pilot-runtime", `${f.a.id}.json`), "{broken-provider");
  writeAtomic(join(spoolDir(f.root), "work-sessions", `work-${"c".repeat(32)}.json`), "{broken-worker");
  writeAtomic(join(spoolDir(f.root), "handoffs", `handoff-${"d".repeat(32)}.json`), "{broken-research");
  const healthy = newPilotChatSession([], `pilot-${"e".repeat(32)}`);
  healthy.backend = { adapter: "pi", model: "synthetic" };
  writeAtomic(f.path(healthy.id), JSON.stringify(healthy));
  const response = await desktopHistory(f.root);
  expect(response.sessions.map((s: { id: string }) => s.id)).toEqual([healthy.id]);
  expect(response.issues).toHaveLength(4);
  expect(response.issues.map((i: { file: string }) => i.file)).toContain(f.path(f.b.id));
  expect(readFileSync(f.path(f.b.id), "utf8")).toBe("{broken");
  expect(readFileSync(join(spoolDir(f.root), "pilot-runtime", `${f.a.id}.json`), "utf8")).toBe("{broken-provider");
});

test("valid JSON with invalid nested fields is isolated before migration, polling or maintenance", async () => {
  const f = fixture(), provider = newPilotChatSession([], `pilot-${"c".repeat(32)}`);
  provider.backend = { adapter: "pi", provider: "openai", model: "synthetic" };
  writeAtomic(f.path(provider.id), JSON.stringify(provider));
  const broken = new Map([
    [f.path(f.a.id), { ...f.a, access: { ...f.a.access, requests: {} } }],
    [f.path(f.b.id), { ...f.b, spoken: {} }],
    [join(spoolDir(f.root), "pilot-runtime", `${provider.id}.json`), { through: 0, actions: [] }],
    [join(spoolDir(f.root), "work-sessions", `work-${"d".repeat(32)}.json`), { id: `work-${"d".repeat(32)}`, title: "Broken context", created: f.a.created, updated: f.a.updated, messages: [], context: { nodes: 42 } }],
    [join(spoolDir(f.root), "handoffs", `handoff-${"e".repeat(32)}.json`), { id: `handoff-${"e".repeat(32)}`, updated_at: f.a.updated, request: { task: "Broken research", user_words: "Research", created_at: f.a.created, selection: { nodes: 42 } } }],
  ] as [string, unknown][]);
  for (const [file, value] of broken) writeAtomic(file, JSON.stringify(value));
  const healthy = newPilotChatSession([], `pilot-${"f".repeat(32)}`);
  healthy.backend = { adapter: "pi", model: "synthetic" };
  writeAtomic(f.path(healthy.id), JSON.stringify(healthy));
  const response = await desktopHistory(f.root);
  expect(response.sessions.map((s: { id: string }) => s.id)).toEqual([healthy.id]);
  expect(response.issues).toHaveLength(broken.size);
  for (const [file, value] of broken) expect(readFileSync(file, "utf8")).toBe(JSON.stringify(value));
});

test("an existing Pi API session uses the replacement key on its next turn", async () => {
  const root = nativeVault(); roots.push(root);
  const oldKey = "sk-synthetic-old-abcdefghijklmnopqrstuvwxyz", newKey = "sk-synthetic-new-abcdefghijklmnopqrstuvwxyz";
  const headers: string[] = [];
  setPilotKey(root, oldKey);
  const chats = new PilotChats(root, { graph: () => [], fetch: (async (_url, init) => {
    headers.push(new Headers(init?.headers).get("authorization")!);
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Synthetic answer" }] }] } })}\n\n`);
  }) as typeof fetch }); open.push(chats);
  chats.setDefaultBackend({ adapter: "pi", provider: "openai", model: "gpt-5.6-terra" });
  const s = chats.create([]);
  chats.send(s.id, "First"); await chats.settled(s.id);
  setPilotKey(root, newKey);
  chats.send(s.id, "Second"); await chats.settled(s.id);
  expect(headers).toEqual([`Bearer ${oldKey}`, `Bearer ${newKey}`]);
  expect(s.phase).toBe("answered");
});
