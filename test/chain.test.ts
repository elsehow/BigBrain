import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { chainHasWork, scheduledVerdict } from "../lib/chain";
import type { SourceInsertion } from "../lib/insertionLog";
import { CHAINS } from "../lib/chains";
import { stage } from "../lib/stageStorage";
import { classicChain, tendDue, type TendResult } from "../lib/tend";
import { fakeIntegrationActivation } from "./support/integrationActivation";
import { insertionSeq, nativeVault, NATIVE_YAML } from "./support/vault";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const insertion = insertionSeq();
const vault = (...insertions: SourceInsertion[]): string => {
  const root = nativeVault({ prefix: "bb-chain-", insertions, files: { "vault.yaml": NATIVE_YAML } });
  scratch.push(root);
  return root;
};

describe("scheduledVerdict — the one scheduled-stage rule", () => {
  const now = new Date("2026-10-04T12:00:00.000Z");
  test("forced runs regardless of clock and work", () => {
    expect(scheduledVerdict({ force: true, work: () => undefined })).toEqual({ due: true, reason: "forced" });
  });
  test("a stage with no clock never runs on its own, and never scans for work", () => {
    expect(scheduledVerdict({ now, work: () => { throw new Error("scanned"); } }).due).toBe(false);
    expect(scheduledVerdict({ now, work: () => "3 new" }).due).toBe(false);
    expect(scheduledVerdict({ now, nextRunAt: "garbage", work: () => "3 new" }).reason).toMatch(/first run is --force/);
  });
  test("an elapsed clock with nothing waiting does not run, in the stage's own words", () => {
    const v = scheduledVerdict({ now, nextRunAt: "2026-10-04T00:00:00.000Z", work: () => undefined, idle: "nothing here" });
    expect(v).toEqual({ due: false, reason: "nothing here" });
  });
  test("work AND an elapsed clock are both required", () => {
    expect(scheduledVerdict({ now, nextRunAt: "2026-10-04T11:59:59.000Z", work: () => "3 new" }))
      .toEqual({ due: true, reason: "scheduled sweep — 3 new" });
    expect(scheduledVerdict({ now, nextRunAt: "2026-10-04T12:00:01.000Z", work: () => "3 new" }))
      .toEqual({ due: false, reason: "next sweep not yet due (3 new waiting)" });
  });
});

describe("the classic chain", () => {
  test("is registered first: tend --json keeps its result at the top level", () => {
    expect(CHAINS[0]).toBe(classicChain);
  });

  test("its due mirrors tendDue: intake and staged are source work, memory is scheduled", () => {
    const root = vault(insertion());
    fakeIntegrationActivation(root);
    stage(root, {
      id: "email-00000000000000000001", source: "email", at: "2026-09-04T10:00:00.000Z",
      line: '2026-09-04 · Evan <evan@example.org> · "Re: timing" · 4k', scopes: { sender: "evan@example.org" },
      name: "re-timing.md", content: "---\nid: email-00000000000000000001\nkind: email\ntitle: \"Re: timing\"\n---\nFriday works.\n",
    });
    const t = tendDue(root);
    const d = classicChain.due(root);
    expect(d.source).toBe(t.intake + t.staged);
    expect(d.source).toBe(2);
    expect(d.scheduled.memory!.due).toBe(t.memory);
    expect(chainHasWork(d)).toBe(true);
  });

  test("nothing waiting is no work", () => {
    expect(chainHasWork({ source: 0, scheduled: { memory: { due: false, reason: "x" } } })).toBe(false);
    expect(chainHasWork({ source: 0, scheduled: { memory: { due: true, reason: "x" } } })).toBe(true);
  });

  test("report: a lock skip is one line and not a failure; a startup error goes to stderr and fails", () => {
    expect(classicChain.report({ ran: false, reason: "another gardener holds the lock", rounds: [] }))
      .toEqual({ lines: ["tend: another gardener holds the lock"], failed: false });
    expect(classicChain.report({ ran: false, error: "engine dependencies missing", rounds: [] } as TendResult))
      .toEqual({ lines: [], failed: true, error: "tend: engine dependencies missing" });
    const r = classicChain.report({
      ran: true,
      rounds: [{ runId: "r1", settled: 2, remaining: 0, error: "boom" }],
      memory: { ran: false } as TendResult["memory"] & object,
    });
    expect(r.failed).toBe(true);
    expect(r.lines).toEqual(["tend: round r1 — 2 settled, 0 remaining — ERROR: boom", "tend: memory — declined"]);
  });
});
