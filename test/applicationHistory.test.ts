import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationActions } from "../lib/applicationActions";
import { PilotChats } from "../lib/pilotChat";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import { DEFAULT_PILOT_BACKEND } from "../lib/pilotBackendTypes";
import { WorkHistory } from "../lib/workHistory";
import { writeAtomic } from "../lib/fsx";
const scratch = () => mkdtempSync(join(tmpdir(), "bb-history-test-"));
const at = "2026-09-01T00:00:00.000Z";
function archive(root: string, n: number) {
  const s = newPilotChatSession([], `pilot-${n.toString(16).padStart(32, "0")}`, at);
  Object.assign(s, { title: "Invented archive", phase: "answered", lifecycle: "ingested", deactivatedAt: at, backend: DEFAULT_PILOT_BACKEND,
    messages: [{ id: "m", role: "user", text: `Invented transcript ${n}`, at }], ingestedMessages: 1 });
  writeAtomic(join(root, ".spool", "pilot-chats", s.id + ".json"), JSON.stringify(s));
  return s;
}
test("receipt pages are bounded, stable across inserts, actor scoped, and rebuildable without replay", async () => {
  const root = scratch(), other = scratch();
  try {
    let reads = 0, effects = 0;
    const actor = { kind: "pilot" as const, id: "synthetic" };
    const actions = new ApplicationActions(root, { now: () => at, observeRead: () => reads++ });
    const host = { authorize() {}, execute() { effects++; return "invented"; } };
    const request = (i: number) => ({ actor, request: `action-${i}`, operation: "test", payload: {}, scope: [] });
    for (let i = 0; i < 80; i++) await actions.execute(request(i), host);
    const first = actions.list(actor, { limit: 7 });
    reads = 0; expect(actions.list(actor, { limit: 7 })).toEqual(first); expect(reads).toBe(7);
    expect(() => actions.list({ ...actor, id: "another" }, { cursor: first.nextCursor })).toThrow("cursor");
    expect(() => new ApplicationActions(other).list(actor, { cursor: first.nextCursor })).toThrow("cursor");
    const newer = new ApplicationActions(root, { now: () => "2026-09-02T00:00:00.000Z" });
    await newer.execute(request(80), host);
    const ids = first.receipts.map(r => r.id); let cursor = first.nextCursor;
    while (cursor) { const page = actions.list(actor, { limit: 7, cursor }); ids.push(...page.receipts.map(r => r.id)); cursor = page.nextCursor; }
    expect(ids).toHaveLength(80); expect(new Set(ids).size).toBe(80);
    const saved = actions.list(actor).receipts[0];
    writeFileSync(join(root, ".state", "application-history", "actions-v1.sqlite"), "damaged derived bytes");
    expect(actions.list(actor).complete).toBe(true);
    await actions.execute(request(80), host); expect(effects).toBe(81);
    writeFileSync(join(root, ".spool", "application-actions", saved.id + ".json"), "damaged authoritative bytes");
    expect(actions.list(actor).complete).toBe(false);
    await expect(actions.execute(request(80), host)).rejects.toThrow("unreadable"); expect(effects).toBe(81);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});
test("warm Pilot archives retain summaries; search and selected detail read only when needed", () => {
  const root = scratch();
  try {
    const records = Array.from({ length: 20 }, (_, i) => archive(root, i));
    let reads = 0; const options = { graph: () => [], observeRead: () => reads++ };
    const cold = new PilotChats(root, options); expect(cold.loadIssues).toEqual([]); cold.close(); expect(reads).toBe(20);
    reads = 0; const warm = new PilotChats(root, options);
    expect(warm.summaries()).toHaveLength(20); expect(reads).toBe(0);
    expect(warm.get(records[0].id).messages[0].text).toContain("transcript 0"); expect(reads).toBe(1);
    expect(warm.summaries("transcript 19").map(s => s.id)).toEqual([records[19].id]);
    reads = 0; warm.get(records[19].id); expect(reads).toBe(1); warm.close();
    writeFileSync(join(root, ".spool", "pilot-chats", records[2].id + ".json"), "damaged");
    rmSync(join(root, ".state", "application-history"), { recursive: true });
    const rebuilt = new PilotChats(root, options); expect(rebuilt.summaries()).toHaveLength(19); expect(rebuilt.loadIssues).toHaveLength(1); rebuilt.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("drafts and interrupted turns are eagerly recovered despite archived labels", () => {
  const root = scratch();
  try {
    const draft = archive(root, 1), running = archive(root, 2);
    draft.draft = "Keep this invented draft"; running.phase = "working";
    for (const s of [draft, running]) writeAtomic(join(root, ".spool", "pilot-chats", s.id + ".json"), JSON.stringify(s));
    const first = new PilotChats(root, { graph: () => [] }); first.close();
    let reads = 0; const restored = new PilotChats(root, { graph: () => [], observeRead: () => reads++ });
    expect(reads).toBeGreaterThan(0); expect(restored.get(draft.id).draft).toBe(draft.draft);
    expect(restored.get(running.id).phase).toBe("interrupted"); restored.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("legacy worker navigation uses cached summaries and selected detail survives cache loss", () => {
  const root = scratch();
  try {
    const ids = Array.from({ length: 20 }, (_, i) => `work-${i.toString(16).padStart(32, "0")}`);
    for (const id of ids) writeAtomic(join(root, ".spool", "work-sessions", id + ".json"), JSON.stringify({ id, title: "Invented work", provider: "codex", cwd: "", status: "working", context: {}, receipts: [], created: at, updated: at, messages: [{ id: "m", role: "user", text: "Invented worker transcript", at }] }));
    let reads = 0; const options = { observeRead: () => reads++ };
    expect(new WorkHistory(root, options).list()).toHaveLength(20); expect(reads).toBe(20);
    reads = 0; const warm = new WorkHistory(root, options); expect(warm.list()).toHaveLength(20); expect(reads).toBe(0);
    expect(warm.get(ids[0]).status).toBe("interrupted"); expect(reads).toBe(1);
    rmSync(join(root, ".state", "application-history"), { recursive: true });
    const rebuilt = new WorkHistory(root); expect(rebuilt.get(ids[19]).messages[0].text).toContain("transcript");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pilot pages include legacy outcomes once, after modern receipts, without importing them", async () => {
  const root = scratch();
  try {
    const { saveConversation, readConversation } = await import("../lib/pilotConversation");
    const saved = archive(root, 1), old = readConversation(root, saved.id);
    old.actions = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`legacy-${i}`, { status: "done" as const, result: "Invented old result" }]));
    saveConversation(root, saved.id, old);
    const actions = new ApplicationActions(root);
    await actions.execute({ actor: { kind: "pilot", id: saved.id }, request: "legacy-0", operation: "test", scope: [], payload: {} }, { authorize() {}, execute() { throw new Error("Legacy must not run"); }, legacy: old.actions["legacy-0"] });
    const chats = new PilotChats(root, { actions, graph: () => [] });
    const seen: string[] = []; let cursor: string | undefined;
    do {
      const page = chats.actionReceipts(saved.id, { limit: 3, cursor });
      expect(page.receipts.length).toBeLessThanOrEqual(3); seen.push(...page.receipts.map(r => r.id)); cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(9); expect(new Set(seen).size).toBe(9); expect(seen).not.toContain("legacy-0");
    expect(actions.list({ kind: "pilot", id: saved.id }).receipts).toHaveLength(1); chats.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
