import { heapStats } from "bun:jsc";
/** Fabricated history only. Run with: bun test/support/applicationHistoryBenchmark.ts */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationActions, canonicalAction } from "../../lib/applicationActions";
import { sha256hex } from "../../lib/hash";
for (const count of [200, 2000, 10000]) {
  const root = mkdtempSync(join(tmpdir(), "bb-history-benchmark-"));
  try {
    const directory = join(root, ".spool", "application-actions"); mkdirSync(directory, { recursive: true });
    for (let i = 0; i < count; i++) {
      const actor = { kind: "pilot" as const, id: `fabricated-${i % 10}` }, request = `request-${i}`;
      const id = sha256hex(canonicalAction([actor, request]));
      const at = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      writeFileSync(join(directory, id + ".json"), JSON.stringify({ version: 1, id, actor, request,
        operation: "contribute", scope: ["vault"], fingerprint: sha256hex(String(i)), status: "completed",
        created: at, updated: at, result: { invented: "Synthetic result. ".repeat(250) } }));
    }
    let files = 0, bytes = 0;
    Bun.gc(true); const before = heapStats().heapSize;
    const start = performance.now();
    const actions = new ApplicationActions(root, { observeRead(size) { files++; bytes += size; } });
    const actor = { kind: "pilot" as const, id: "fabricated-0" };
    const cold = actions.list(actor, { limit: 30 });
    const coldMs = performance.now() - start, coldFiles = files, coldBytes = bytes;
    files = 0; bytes = 0;
    const warmStart = performance.now();
    let returned = 0;
    for (let i = 0; i < 5; i++) returned = actions.list(actor, { limit: 30 }).receipts.length;
    const warmMs = (performance.now() - warmStart) / 5;
    Bun.gc(true);
    console.log(JSON.stringify({ count, coldMs: +coldMs.toFixed(2), coldFiles, coldBytes, warmMs: +warmMs.toFixed(2),
      warmFiles: files / 5, warmBytes: bytes / 5, returned, coldReturned: cold.receipts.length,
      retainedHeapBytes: heapStats().heapSize - before }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// Constructor/navigation costs are separate from receipt lookups. Warm means
// a process restart with an existing derived index, not an already loaded object.
const { PilotChats } = await import("../../lib/pilotChat");
const { WorkHistory } = await import("../../lib/workHistory");
const { newPilotChatSession } = await import("../../lib/pilotChatTypes");
const { DEFAULT_PILOT_BACKEND } = await import("../../lib/pilotBackendTypes");
for (const count of [200, 2000, 10000]) {
  const root = mkdtempSync(join(tmpdir(), "bb-archive-benchmark-"));
  try {
    const pilotDir = join(root, ".spool", "pilot-chats"), workDir = join(root, ".spool", "work-sessions");
    mkdirSync(pilotDir, { recursive: true }); mkdirSync(workDir, { recursive: true });
    const at = "2026-09-01T00:00:00.000Z", text = "Invented historical message. ".repeat(180);
    for (let i = 0; i < count; i++) {
      const suffix = i.toString(16).padStart(32, "0"), id = "pilot-" + suffix;
      const pilot = { ...newPilotChatSession([], id, at), title: "Invented history", phase: "answered", lifecycle: "ingested", deactivatedAt: at,
        backend: DEFAULT_PILOT_BACKEND, ingestedMessages: 1, messages: [{ id: "m", role: "user", text, at }] };
      writeFileSync(join(pilotDir, id + ".json"), JSON.stringify(pilot));
      const work = { id: "work-" + suffix, title: "Invented history", provider: "codex", cwd: "", status: "idle", context: {}, receipts: [], created: at, updated: at,
        messages: [{ id: "m", role: "user", text, at }] };
      writeFileSync(join(workDir, work.id + ".json"), JSON.stringify(work));
    }
    for (const kind of ["pilot", "worker"] as const) {
      let files = 0, bytes = 0;
      const create = () => kind === "pilot" ? new PilotChats(root, { graph: () => [], observeRead(size) { files++; bytes += size; } })
        : new WorkHistory(root, { observeRead(size) { files++; bytes += size; } });
      const list = (owner: ReturnType<typeof create>) => "summaries" in owner ? owner.summaries() : owner.list();
      const start = performance.now(); let cold: ReturnType<typeof create> | undefined = create(); list(cold);
      const coldMs = performance.now() - start, coldFiles = files, coldBytes = bytes;
      if ("close" in cold) cold.close(); cold = undefined;
      Bun.gc(true); const before = heapStats().heapSize;
      files = 0; bytes = 0; const warmStart = performance.now(), warm = create(); const returned = list(warm).length;
      const warmMs = performance.now() - warmStart, warmFiles = files, warmBytes = bytes;
      Bun.gc(true); const retainedHeapBytes = heapStats().heapSize - before;
      // Serialized payload size is a reproducible retention measure independent
      // of GC/interning noise. It is not the allocator's resident memory size.
      const held = warm as unknown as { sessions?: Map<string, unknown>; jobs?: Map<string, unknown>; archives?: Map<string, unknown> };
      const retainedRecordBytes = [held.sessions, held.jobs, held.archives].reduce((sum, map) => sum + (map ? Buffer.byteLength(JSON.stringify([...map.values()])) : 0), 0);
      files = 0; bytes = 0; const detailStart = performance.now(); warm.get(`${kind === "pilot" ? "pilot" : "work"}-${"0".repeat(32)}`);
      console.log(JSON.stringify({ kind, count, coldMs: +coldMs.toFixed(2), coldFiles, coldBytes, warmMs: +warmMs.toFixed(2), warmFiles, warmBytes,
        returned, retainedHeapBytes, retainedRecordBytes, detailMs: +(performance.now() - detailStart).toFixed(2), detailFiles: files, detailBytes: bytes }));
      if ("close" in warm) warm.close();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
