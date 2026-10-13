import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chainHasWork } from "../lib/chain";
import { assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { appendAndProjectAssertion, syncAssertionProjection } from "../lib/assertionProjection";
import { admissionChain, briefingsChain, CHAINS, chainOfJob, copiesChain, foldsChain } from "../lib/chains";
import { CADENCE, CHAIN_JOBS } from "../lib/desktopSchedule";
import { readMemoryStamp, writeMemoryStamp } from "../lib/memory";
import { insertion, nativeVault, NATIVE_YAML } from "./support/vault";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const minutes = insertion({ id: `ins_${"a".repeat(24)}`, source_id: "minutes", received_at: "2026-08-02T09:00:00.000Z" });
function vault(): string {
  const root = nativeVault({ prefix: "bb-chains-", insertions: [minutes], files: { "vault.yaml": NATIVE_YAML } });
  roots.push(root);
  syncAssertionProjection(root);
  return root;
}
const ent = (label: string) => ({ id: assertionEntityId(label), label });
function claim(root: string, at: string): void {
  const [a, b] = [ent("Ada Lovelace"), ent("Atlas")];
  appendAndProjectAssertion(root, createAssertionEvent({ text: `[[${a.id}|${a.label}]] met [[${b.id}|${b.label}]] (${at}).`, entities: [a, b],
    sources: [minutes.id], author: { kind: "user", id: "owner" }, confidence: "direct", created_at: at,
    produced_by: { procedure: "test", version: "1" } }, new Map([[minutes.id, minutes]])));
}

test("the supervisor plans every chain, each on a cadence of its own", () => {
  expect(CHAINS.map((chain) => chain.job)).toEqual([...CHAIN_JOBS]);
  expect(CHAINS[0]!.name).toBe("classic");
  for (const job of CHAIN_JOBS) expect(CADENCE[job]).toBeGreaterThan(0);
  expect(chainOfJob("copies")).toBe(copiesChain);
});

test("an empty vault has nothing due but the classic chain's say", () => {
  const root = vault();
  for (const chain of [copiesChain, foldsChain, briefingsChain, admissionChain]) expect(chainHasWork(chain.due(root))).toBe(false);
});

test("fold proposals wait for memory, then for a changed entity and the memory interval", () => {
  const root = vault();
  claim(root, "2026-08-02T10:00:00.000Z");
  const due = (now: string) => foldsChain.due(root, { now: new Date(now) }).scheduled["folds"]!;
  expect(due("2026-08-03T00:00:00.000Z")).toMatchObject({ due: false, reason: "no stamp — first run is --force" });
  writeMemoryStamp(root, { ...readMemoryStamp(root), lastRunAt: "2026-08-02T12:00:00.000Z" });
  expect(due("2026-08-03T00:00:00.000Z")).toMatchObject({ due: true });
  // a proposal stands: nothing changed since it, then a claim lands, then the interval passes
  writeFileSync(join(root, ".state", "entity-folds.json"), JSON.stringify({ proposedAt: "2026-08-03T00:00:00.000Z", model: "m", census: 2, groups: [], dropped: [], wallMs: 0 }));
  expect(due("2026-08-05T00:00:00.000Z")).toMatchObject({ due: false, reason: "no entity gained a claim since the last proposal" });
  claim(root, "2026-08-04T00:00:00.000Z");
  expect(due("2026-08-03T06:00:00.000Z")).toMatchObject({ due: false });
  expect(due("2026-08-05T00:00:00.000Z")).toMatchObject({ due: true });
});

test("briefings warm once after each memory sweep", async () => {
  const root = vault();
  expect(briefingsChain.due(root).source).toBe(0);
  writeMemoryStamp(root, { ...readMemoryStamp(root), lastRunAt: "2026-08-02T12:00:00.000Z" });
  expect(briefingsChain.due(root).source).toBe(1);
  const result = await briefingsChain.run({ root, manifest: {} as never });
  expect(result.error).toBeUndefined();
  expect(briefingsChain.due(root).source).toBe(0);
  writeMemoryStamp(root, { ...readMemoryStamp(root), lastRunAt: "2026-08-03T12:00:00.000Z" });
  expect(briefingsChain.due(root).source).toBe(1);
});

test("`bigbrain tend --chain` names a job, or refuses", () => {
  const root = vault();
  const run = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dir, "..", "bin", "tend.ts"), ...args],
    { cwd: root, env: { ...process.env, BIGBRAIN_VAULT: root, HOME: root }, encoding: "utf8" });
  const unknown = run("--chain", "nope");
  expect(unknown.status).toBe(2);
  expect(unknown.stderr).toContain("--chain wants one of tend, copies, folds, briefings, lenses, admission");
  const copies = run("--chain", "copies");
  expect(copies.status).toBe(0);
  expect(copies.stdout).toContain("nothing due");
});
