import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileModule } from "../web/ui/node_modules/svelte/compiler";

const dir = mkdtempSync(join(tmpdir(), "bb-delivery-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "support/pilotDeliveryHarness.ts")],
  outdir: dir, target: "browser", conditions: ["browser"],
  plugins: [{ name: "svelte-runes", setup(build) {
    build.onResolve({ filter: /^svelte(?:\/|$)/ }, ({ path }) => ({
      path: path === "svelte" ? join(import.meta.dir, "../web/ui/node_modules/svelte/src/index-client.js")
        : Bun.resolveSync(path, join(import.meta.dir, "../web/ui")),
    }));
    build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const source = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(path).text());
      return { contents: compileModule(source, { filename: path, generate: "client" }).js.code, loader: "js" };
    });
  } }],
});
if (!build.success) throw new Error(build.logs.join("\n"));
const h = await import(build.outputs[0]!.path) as typeof import("./support/pilotDeliveryHarness");
import { newPilotChatSession } from "../lib/pilotChatTypes";
import { pilotChatDetail } from "../lib/pilotChatSummary";
import { transitionPilot } from "../lib/pilotTransitions";
const oldFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = oldFetch; });
// The stubs below replace a process-wide global; later test files must get the original back.
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
afterEach(() => { if (oldStorage) Object.defineProperty(globalThis, "sessionStorage", oldStorage); else delete (globalThis as { sessionStorage?: Storage }).sessionStorage; });
for (const lost of [true, false]) test(`production client initialization reconciles ${lost ? "lost" : "delayed"} POST, stable order, answer and follow-up interleaving`, async () => {
  h.chat.sessions = [];
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k),
  } });
  h.configurePilotCoordination({ navigate() {}, selection: () => [], clearSelection() {}, recordChanged() {}, settled() {}, refreshWorkers: async () => {} });
  let s = newPilotChatSession([]);
  const other = newPilotChatSession([]);
  let resolvePost: ((r: Response) => void) | undefined;
  let rejectPost: ((e: Error) => void) | undefined;
  const response = (v: unknown) => Response.json(v);
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/vault") return response({});
    if (path === "/api/pilot/chat") return response({ sessions: [pilotChatDetail(s), pilotChatDetail(other)] });
    if (path.endsWith("/draft")) return response(pilotChatDetail(s));
    if (path.endsWith("/send")) {
      const b = JSON.parse(String(init?.body));
      s = transitionPilot(s, { kind: "input", input: { id: b.inputId, text: b.text, mode: "text" }, message: "different-envelope", turn: "turn", at: s.updated, queue: true }).state;
      s = transitionPilot(s, { kind: "message", turn: "turn", message: { id: "answer", role: "assistant", text: "Fabricated answer", at: s.updated } }).state;
      s.revision += 2;
      return new Promise<Response>((resolve, reject) => { resolvePost = resolve; rejectPost = reject; });
    }
    throw new Error(`Unexpected fabricated request: ${path}`);
  }) as typeof fetch;
  await h.refreshChats();
  h.chat.activeId = s.id; h.chat.open = true; h.chat.drafts[s.id] = "Fabricated question";
  const pending = h.sendChat();
  while (!rejectPost) await new Promise(resolve => setTimeout(resolve, 1));
  await h.refreshChats();
  expect(h.chat.sessions.map(s => s.id)).toEqual([s.id, other.id]);
  expect(h.chat.queued[s.id]).toBeUndefined();
  expect(storage.has(h.vaultStorageKey(`pilot-pending:${s.id}`))).toBe(false);
  expect(h.chat.sessions[0]?.messages?.at(-1)?.text).toBe("Fabricated answer");
  const fresh = s;
  s = { ...s, revision: s.revision - 1, inputs: [], messages: [] };
  await h.refreshChats();
  expect(h.chat.sessions[0]?.messages?.at(-1)?.text).toBe("Fabricated answer");
  s = fresh;
  h.chat.drafts[s.id] = "New follow-up";
  // A lost POST after the receipt must not restore the old question.
  if (lost) rejectPost!(new Error("lost response"));
  else resolvePost!(response(pilotChatDetail(s)));
  await pending;
  expect(h.chat.drafts[s.id]).toBe("New follow-up");
});
test("a delivery proven during the retry backoff is not posted again", async () => {
  h.chat.sessions = [];
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k),
  } });
  h.configurePilotCoordination({ navigate() {}, selection: () => [], clearSelection() {}, recordChanged() {}, settled() {}, refreshWorkers: async () => {} });
  let s = newPilotChatSession([]);
  let posts = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/vault") return Response.json({});
    if (path === "/api/pilot/chat") return Response.json({ sessions: [pilotChatDetail(s)] });
    if (path.endsWith("/draft")) return Response.json(pilotChatDetail(s));
    if (path.endsWith("/send")) {
      posts++;
      const b = JSON.parse(String(init?.body));
      s = transitionPilot(s, { kind: "input", input: { id: b.inputId, text: b.text, mode: "text" }, message: "accepted", turn: "turn", at: s.updated, queue: true }).state;
      s.revision++;
      throw new TypeError("connection reset"); // accepted, but the response is lost
    }
    throw new Error(`Unexpected fabricated request: ${path}`);
  }) as typeof fetch;
  await h.refreshChats();
  h.chat.activeId = s.id; h.chat.open = true; h.chat.drafts[s.id] = "Fabricated question";
  const original = globalThis.setTimeout;
  const backoff = new Promise<void>(resolve => {
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (ms === 500) { globalThis.setTimeout = original; resolve(); }
      return original(fn, ms);
    }) as typeof setTimeout;
  });
  const pending = h.sendChat();
  await backoff;
  await h.refreshChats(); // the event stream's refresh proves delivery before the retry
  await pending;
  expect(posts).toBe(1);
  expect(h.chat.error).toBe("");
  expect(h.chat.drafts[s.id] ?? "").toBe("");
  expect(storage.has(h.vaultStorageKey(`pilot-pending:${s.id}`))).toBe(false);
  expect(h.chat.sessions.find(n => n.id === s.id)?.messages?.filter(m => m.role === "user")).toHaveLength(1);
});
