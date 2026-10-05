import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionRefusal, ApplicationActions, actionFailure, actionReceiptView, type ActionRequest } from "../lib/applicationActions";
import { writeAtomic } from "../lib/fsx";
const request: ActionRequest = { actor: { kind: "pilot", id: "pilot-fixture" }, request: "input-action", operation: "drop", scope: ["vault"], payload: { content: "Invented source" } };
const scratch = () => mkdtempSync(join(tmpdir(), "application-actions-"));

test("duplicate delivery joins in-flight execution; conflicting payloads fail and restart preserves attribution", async () => {
  const root = scratch();
  try {
    let calls = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const actions = new ApplicationActions(root);
    const host = { authorize() {}, async execute() { calls++; await gate; return { id: "receipt" }; } };
    const first = actions.execute(request, host), duplicate = actions.execute(request, host);
    await expect(actions.execute({ ...request, payload: { content: "Different" } }, host)).rejects.toThrow("different request");
    release(); expect(await first).toEqual(await duplicate); expect(calls).toBe(1);
    const restarted = new ApplicationActions(root);
    expect(await restarted.execute(request, host)).toEqual({ id: "receipt" }); expect(calls).toBe(1);
    expect(restarted.list(request.actor).receipts[0]).toMatchObject({ actor: request.actor, scope: ["vault"], status: "completed" });
    await expect(restarted.execute(request, { ...host, authorize() { throw new Error("Revoked"); } })).rejects.toThrow("Revoked");
    expect(calls).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("crash after preparing but before execution may resume; crash after an effect must not replay", async () => {
  const root = scratch();
  try {
    let calls = 0;
    const host = { authorize() {}, execute() { calls++; return { id: "saved-source" }; } };
    const before = new ApplicationActions(root, { write(path, receipt) { writeAtomic(path, JSON.stringify(receipt), 0o600); throw new Error("crash"); } });
    await expect(before.execute(request, host)).rejects.toThrow("crash"); expect(calls).toBe(0);
    expect(await new ApplicationActions(root).execute(request, host)).toEqual({ id: "saved-source" }); expect(calls).toBe(1);
    const second = { ...request, request: "second-action" };
    const after = new ApplicationActions(root, { write(path, receipt) {
      if (receipt.status === "completed") throw new Error("crash after effect");
      writeAtomic(path, JSON.stringify(receipt), 0o600);
    } });
    await expect(after.execute(second, host)).rejects.toThrow("crash after effect"); expect(calls).toBe(2);
    const restarted = new ApplicationActions(root);
    await expect(restarted.execute(second, host)).rejects.toThrow("uncertain outcome"); expect(calls).toBe(2);
    expect(restarted.list(request.actor).receipts.find(r => r.request === second.request)?.status).toBe("uncertain");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("revocation before dispatch is a known failure; cancellation during an external effect is uncertain", async () => {
  const root = scratch();
  try {
    const actions = new ApplicationActions(root); let checks = 0, calls = 0;
    await expect(actions.execute(request, { authorize() { if (++checks === 2) throw new Error("Revoked"); }, execute() { calls++; } })).rejects.toThrow("Revoked");
    expect(calls).toBe(0); expect(actions.list(request.actor).receipts[0].status).toBe("failed");
    const controller = new AbortController();
    await expect(actions.execute({ ...request, request: "cancelled" }, { signal: controller.signal, authorize() {}, execute() { calls++; controller.abort(); throw new Error("Lost response"); } })).rejects.toThrow("confirmed outcome");
    expect(actions.list(request.actor).receipts.find(r => r.request === "cancelled")?.status).toBe("uncertain");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a proven refusal fails safely and may run again; an observed effect stays uncertain until durable evidence settles it", async () => {
  const root = scratch();
  try {
    const actions = new ApplicationActions(root); let calls = 0;
    const refused = { ...request, request: "refused" };
    await expect(actions.execute(refused, { authorize() {}, execute() { calls++; throw new ActionRefusal("Invented capacity refusal"); } })).rejects.toThrow("Invented capacity refusal");
    const failed = actions.receipt(refused)!;
    expect(failed).toMatchObject({ status: "failed", stage: "execute", cause: "Invented capacity refusal", error: "Invented capacity refusal" });
    expect(actionFailure("drop", new Error("Invented capacity refusal"), failed)).toEqual({ error: "Invented capacity refusal", request: failed.id, operation: "drop", status: "failed", stage: "execute", retry: "safe" });
    expect(await actions.execute(refused, { authorize() {}, execute() { calls++; return "ran"; } })).toBe("ran"); expect(calls).toBe(2);
    expect(actions.receipt(refused)).toMatchObject({ status: "completed", result: "ran" });
    expect(actions.receipt(refused)?.cause).toBeUndefined();

    const agent = `work-${"c".repeat(32)}`, lost = { ...request, operation: "launch_agent", request: "lost" };
    // An observed identity outranks a refusal: something may exist.
    await expect(actions.execute(lost, { authorize() {}, execute({ observe }) { calls++; observe({ agent }); throw new ActionRefusal("Invented late refusal"); } })).rejects.toThrow("confirmed outcome");
    const uncertain = actions.receipt(lost)!;
    expect(uncertain).toMatchObject({ status: "uncertain", stage: "execute", cause: "Invented late refusal", observed: { agent } });
    expect(actionReceiptView(uncertain).observations).toEqual([{ kind: "agent", target: agent, confirmed: false }]);
    expect(actionFailure("launch_agent", new Error("x"), uncertain)).toMatchObject({ status: "unknown", retry: "blocked", agent, cause: "Invented late refusal" });
    expect(actionFailure("launch_agent", new Error("Unreadable"), null)).toMatchObject({ status: "unknown", retry: "blocked" });
    const restarted = new ApplicationActions(root);
    await expect(restarted.execute(lost, { authorize() {}, execute() { calls++; }, recover: () => undefined })).rejects.toThrow("confirmed outcome");
    expect(await restarted.execute(lost, { authorize() {}, execute() { calls++; }, recover: r => ({ id: r.observed?.agent }) })).toEqual({ id: agent });
    expect(calls).toBe(3);
    expect(restarted.receipt(lost)).toMatchObject({ status: "completed", result: { id: agent }, cause: "Invented late refusal" });
    expect(restarted.owned({ kind: "pilot", id: "another-pilot" }, uncertain.id)).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("historical receipts import without execution and batch results retain partial failures", async () => {
  const root = scratch();
  try {
    let calls = 0; const actions = new ApplicationActions(root);
    expect(await actions.execute(request, { authorize() {}, execute() { calls++; }, legacy: { status: "done", result: { path: "saved" } } })).toEqual({ path: "saved" });
    expect(calls).toBe(0);
    await expect(actions.execute({ ...request, request: "old-pending" }, { authorize() {}, execute() { calls++; }, legacy: { status: "pending" } })).rejects.toThrow("uncertain outcome");
    const results = { ok: false, results: [{ path: "first", ok: true }, { path: "second", ok: false, error: "Provider did not confirm" }] };
    const batch = { ...request, actor: { kind: "user" as const, id: "desktop" }, request: "batch", operation: "source_set_unread" };
    await actions.execute(batch, { authorize() {}, execute() { calls++; return results; } });
    expect(await new ApplicationActions(root).execute(batch, { authorize() {}, execute() { calls++; return results; } })).toEqual(results);
    expect(calls).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const damage of ["json", "version", "actor", "status", "identity"] as const) test(`damaged ${damage} receipt is isolated for inspection but blocks its exact action after restart`, async () => {
  const root = scratch();
  try {
    const actions = new ApplicationActions(root);
    let effects = 0;
    const host = { authorize() {}, execute() { effects++; return { privateResult: "Fabricated private result" }; } };
    await actions.execute(request, host);
    const receipt = actions.list(request.actor).receipts[0]!;
    const path = join(root, ".spool", "application-actions", receipt.id + ".json");
    const damaged = damage === "json" ? "{Fabricated private bytes" : JSON.stringify({ ...receipt,
      ...(damage === "version" ? { version: 2 } : {}),
      ...(damage === "actor" ? { actor: null } : {}),
      ...(damage === "status" ? { status: "unknown" } : {}),
      ...(damage === "identity" ? { actor: { kind: "pilot", id: "different-actor" } } : {}),
    });
    writeFileSync(path, damaged);
    const other = { ...request, actor: { kind: "pilot" as const, id: "unrelated-pilot" } };
    await actions.execute(other, host);
    for (const service of [actions, new ApplicationActions(root)]) {
      const history = service.list(other.actor);
      expect(history.receipts).toHaveLength(1);
      expect(history.receipts[0]?.actor).toEqual(other.actor);
      expect(history).toMatchObject({ complete: false, issues: [{ kind: "receipt", count: 1 }] });
      expect(JSON.stringify(history.issues)).not.toContain("Fabricated");
      expect(JSON.stringify(history.issues)).not.toContain(root);
      await expect(service.execute(request, host)).rejects.toThrow("unreadable; execution is blocked");
      await expect(service.execute(request, { ...host, legacy: { status: "done", result: "Historic" } })).rejects.toThrow("execution is blocked");
      expect(readFileSync(path, "utf8")).toBe(damaged);
    }
    expect(effects).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("history distinguishes an absent store, a directory failure, and bounded per-record issues", async () => {
  const root = scratch();
  try {
    const actions = new ApplicationActions(root);
    expect(actions.list(request.actor)).toEqual({ receipts: [], issues: [], complete: true });
    const directory = join(root, ".spool", "application-actions");
    writeAtomic(directory, "Fabricated unreadable directory");
    expect(actions.list(request.actor)).toMatchObject({ complete: false, issues: [{ kind: "directory", count: 1 }] });
    await expect(actions.execute(request, { authorize() {}, execute() { throw new Error("Must not execute"); } })).rejects.toThrow("execution is blocked");
    rmSync(directory);
    for (let i = 0; i < 40; i++) writeAtomic(join(directory, i.toString(16).padStart(64, "0") + ".json"), "{damaged");
    const history = actions.list(request.actor);
    expect(history).toMatchObject({ complete: false, receipts: [], issues: [{ kind: "receipt", count: 40 }] });
    expect(history.issues).toHaveLength(1);
    expect(JSON.stringify(history.issues).length).toBeLessThan(500);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
