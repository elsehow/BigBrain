import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuickQueue, withQuickSlot } from "../lib/run/quickQueue";
import { runAgent } from "../lib/run/agent";
import { nativeVault } from "./support/vault";
import { fakePi } from "./support/pi";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw Error("Work did not start"); await Bun.sleep(10); }
}

test("a shared queue admits two calls in order, removes cancelled work, and releases a failed slot", async () => {
  const queue = new QuickQueue(2), gates = [deferred(), deferred()], started: number[] = [];
  const request = (i: number, signal?: AbortSignal) => queue.run(async () => {
    started.push(i); await gates[i]?.promise;
    if (i === 0) throw Error("Provider unavailable");
    return i;
  }, signal);
  const controller = new AbortController();
  const work = [request(0), request(1), request(2, controller.signal), request(3)];
  const settled = Promise.allSettled(work);
  await Promise.resolve();
  expect(started).toEqual([0, 1]);
  controller.abort(); gates[0]!.resolve();
  await until(() => started.length === 3);
  expect(started).toEqual([0, 1, 3]);
  gates[1]!.resolve();
  expect((await settled).map(r => r.status)).toEqual(["rejected", "fulfilled", "rejected", "fulfilled"]);
  expect(await queue.run(async () => "next")).toBe("next");
});

test("the same vault's slots cap separate processes, cancel waiters, and recover after a crash", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-quick-slots-")); roots.push(root);
  const child = Bun.spawn([process.execPath, "-e", `
    const { withQuickSlot } = await import(process.env.QUICK_MODULE);
    const block = async () => { console.log('started'); await new Promise(r => setTimeout(r, 600000)); };
    await Promise.all([withQuickSlot(process.env.QUICK_ROOT, block), withQuickSlot(process.env.QUICK_ROOT, block)]);
  `], { env: { ...process.env, QUICK_MODULE: join(import.meta.dir, "../lib/run/quickQueue.ts"), QUICK_ROOT: root }, stdout: "pipe", stderr: "inherit" });
  try {
    const reader = child.stdout.getReader(); let output = "";
    while (output.split("started").length < 3) output += new TextDecoder().decode((await reader.read()).value);
    let calls = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try { await expect(withQuickSlot(root, async () => { calls++; }, controller.signal)).rejects.toThrow(); }
    finally { clearTimeout(timer); }
    expect(calls).toBe(0);
    child.kill(9); await child.exited;
    expect(await withQuickSlot(root, async () => "recovered")).toBe("recovered");
  } finally { child.kill(9); await child.exited; }
});

test("the production executor budgets Quick before opening Pi sessions and preserves other roles", async () => {
  const root = nativeVault(); roots.push(root);
  const gate = deferred(), started: string[] = [];
  const request = (prompt: string, role = "quick", queueSignal?: AbortSignal) => runAgent({
    root, role, auth: "max", target: { adapter: "pi", provider: "anthropic", model: "claude-haiku-4-5" },
    capabilities: "none", prompt, queueSignal, timeoutMs: 3000,
  }, fakePi(async text => { started.push(text); if (role === "quick") await gate.promise; return { result: "Ready" }; }));
  const controller = new AbortController();
  const work = [request("first"), request("second"), request("cancelled", "quick", controller.signal), request("last")];
  const settled = Promise.allSettled(work);
  try {
    await until(() => started.length === 2);
    expect(started).toHaveLength(2);
    await request("independent", "memory");
    expect(started).toHaveLength(3);
    controller.abort();
  } finally { gate.resolve(); }
  expect((await settled).map(r => r.status)).toEqual(["fulfilled", "fulfilled", "rejected", "fulfilled"]);
  expect(started.some(p => p.startsWith("cancelled"))).toBe(false);
  expect(started.at(-1)).toMatch(/^last/);
});
