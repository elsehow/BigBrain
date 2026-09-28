import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitoredSession, readModelRuns, usageSample } from "../lib/run/monitor";
import { summarizeProvider } from "../lib/providerMonitor";
import type { ModelSession, ModelSessionSetup, ModelSessionTurn } from "../lib/run/session";
import type { RunRecord } from "../lib/run/monitorTypes";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const setup = (provider = "openai-codex"): ModelSessionSetup => {
  const root = mkdtempSync(join(tmpdir(), "model-monitor-")); roots.push(root);
  return { root, config: { adapter: "pi", model: "fixture", provider }, instructions: "", tools: [], state: { through: 0 }, save() {} };
};
const turn = (overrides: Partial<ModelSessionTurn> = {}): ModelSessionTurn => ({ signal: new AbortController().signal,
  connected() {}, delta() {}, tool: async () => null, input: () => "", messages: [], reference: () => "", ...overrides });
const fake = (fn: ModelSession["turn"]): ModelSession => ({ transport: "subscription", broken: false, sessionId: "session-1", prepare: async () => true, close() {}, turn: fn });
const sample = (id = "request") => usageSample(id, "fixture", { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 }, "pi");

test("all roles and providers persist deduplicated partial usage before failure or cancellation", async () => {
  for (const provider of ["openai-codex", "anthropic"]) for (const role of ["pilot", "tend", "memory", "quick"]) {
    const s = setup(provider), controller = new AbortController();
    const client = monitoredSession(fake(async args => {
      args.connected(); args.observe?.(sample()); args.observe?.(sample());
      expect(readModelRuns(s.root, "2000")[0]!.samples).toHaveLength(1);
      if (role === "quick") controller.abort();
      throw new Error("do not journal this sensitive error");
    }), s, role);
    await expect(client.turn(turn({ signal: controller.signal }))).rejects.toThrow();
    const [r] = readModelRuns(s.root, "2000");
    expect(r!.role).toBe(role === "tend" ? "gardener" : role);
    expect(r!.provider).toBe(provider);
    expect(r!.phase).toBe(role === "quick" ? "cancelled" : "failed");
    expect(r!.samples[0]!.input).toBe(100);
    expect(JSON.stringify(r)).not.toContain("sensitive");
  }
});

test("nested tool work inherits parent run, but keeps its role; turns have distinct IDs", async () => {
  const s = setup();
  const child = monitoredSession(fake(async a => { a.connected(); a.observe?.(sample()); return "done"; }), s, "quick");
  const pilot = monitoredSession(fake(async a => { a.connected(); await a.tool("quick", {}); return "done"; }), s, "pilot");
  for (let i = 0; i < 2; i++) await pilot.turn(turn({ tool: () => child.turn(turn()) }));
  const runs = readModelRuns(s.root, "2000");
  expect(new Set(runs.map(r => r.id)).size).toBe(4);
  for (const quick of runs.filter(r => r.role === "quick")) expect(runs.find(r => r.id === quick.parentId)?.role).toBe("pilot");
  expect(runs.filter(r => r.role === "pilot")[0]!.lifecycle.map(e => e.phase)).toEqual(["preparing", "running", "waiting_for_tools", "running", "completed"]);
});

test("validation failures remain failures even after model completion", async () => {
  const s = setup();
  const session = monitoredSession(fake(async a => { a.observe?.(sample()); return "invalid"; }), s, "quick", () => { throw Error("schema"); });
  await expect(session.turn(turn())).rejects.toThrow("schema");
  expect(readModelRuns(s.root, "2000")[0]!.phase).toBe("failed");
});

test("normalization distinguishes missing counts and keeps Pi cache counts separate", () => {
  const u = usageSample("x", "model", { input: 30, output: 10, cacheRead: 70 }, "pi");
  expect(u.input).toBe(30); expect(u.cacheRead).toBe(70); expect(u.estimatedCostUsd).toBeNull();
  expect(usageSample("x", "model", { input: NaN, output: -1 }, "pi").input).toBeNull();
  expect(usageSample("x", "model", undefined, "pi").output).toBeNull();
});

const now = new Date("2026-09-24T12:00:00Z");
const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({ version: 1, id: "run", role: "pilot", adapter: "claude", provider: "anthropic", model: "sonnet", accountId: "account", sessionId: "s", transport: "subscription", startedAt: "2026-09-24T11:50:00Z", updatedAt: "2026-09-24T11:55:00Z", finishedAt: "2026-09-24T11:55:00Z", phase: "completed", lifecycle: [], samples: [sample()], quota: [
  { kind: "quota", window: "seven_day", used: .2, resetsAt: "2026-09-27T00:00:00Z", at: "2026-09-24T11:51:00Z" },
  { kind: "quota", window: "seven_day", used: .24, resetsAt: "2026-09-27T00:00:00Z", at: "2026-09-24T11:54:00Z" },
], ...overrides });

test("provider summaries keep account readings separate from role tokens, including overlapping runs", () => {
  const r = record();
  let view = summarizeProvider("anthropic", [r], now);
  expect(view.roles[0]!.tokens).toBe(160);
  expect(view.quota.windows[0]).toEqual({ window: "seven_day", used: .24, resetsAt: r.quota[1]!.resetsAt, asOf: r.quota[1]!.at, stale: false });
  view = summarizeProvider("anthropic", [r, record({ id: "other", role: "quick" })], now);
  expect(view.quota.windows[0]!.used).toBe(.24);
  expect(view.roles).toHaveLength(2);
});

test("reset crossings, unknown identities, mixed accounts, stale and unsupported meters", () => {
  const r = record();
  r.quota[0]!.resetsAt = "2026-09-24T11:52:00Z";
  expect(summarizeProvider("anthropic", [r], now).quota.windows[0]!.used).toBe(.24);
  expect(summarizeProvider("anthropic", [record({ accountId: null })], now).quota.state).toBe("unavailable");
  const mixed = summarizeProvider("anthropic", [record(), record({ id: "b", accountId: "b" })], now);
  expect(mixed.accountIdentity).toBe("multiple"); expect(mixed.quota.windows).toHaveLength(0);
  expect(summarizeProvider("anthropic", [record()], new Date("2026-09-24T13:00:00Z")).quota.state).toBe("stale");
  expect(summarizeProvider("openai-codex", [], now).quota.state).toBe("unavailable");
  const partial = summarizeProvider("anthropic", [record({ samples: [], phase: "cancelled" })], now);
  expect(partial.roles[0]!.measuredRuns).toBe(0); expect(partial.roles[0]!.partial).toBe(true);
});

test("request identity is preserved across account changes within a turn and never inferred from a later account", async () => {
  const s = setup();
  const session = { ...fake(async args => {
    session.accountId = "first";
    args.observe?.(sample("first-request"));
    session.accountId = "second";
    args.observe?.(sample("second-request"));
    args.observe?.({ kind: "quota", window: "five_hour", used: .2, resetsAt: new Date(Date.now() + 3600_000).toISOString() });
    session.accountId = undefined;
    return "done";
  }), accountId: undefined as string | undefined };
  await monitoredSession(session, s, "pilot").turn(turn());
  const [run] = readModelRuns(s.root, "2000");
  expect(run!.accountId).toBeNull();
  expect(run!.samples.map(s => s.accountId)).toEqual(["first", "second"]);
  expect(run!.samples.every(s => Number.isFinite(Date.parse(s.at!)))).toBe(true);
  const view = summarizeProvider("openai-codex", [run!]);
  expect(view.roles[0]!.tokens).toBe(320);
  expect(view.accountIdentity).toBe("multiple");
  expect(view.quota.windows).toEqual([]);
});

test("quota freshness belongs to each window and future observations are ignored", () => {
  const r = record();
  r.quota.push({ ...r.quota[1]!, window: "five_hour", resetsAt: "2026-09-24T11:59:00Z" });
  r.quota.push({ ...r.quota[1]!, at: "2026-09-24T13:00:00Z", used: 1 });
  const view = summarizeProvider("anthropic", [r], now);
  expect(view.quota.state).toBe("stale");
  expect(view.quota.windows.find(w => w.window === "five_hour")!.stale).toBe(true);
  expect(view.quota.windows.find(w => w.window === "seven_day")!.stale).toBe(false);
  expect(view.quota.windows.find(w => w.window === "seven_day")!.used).toBe(.24);
});
