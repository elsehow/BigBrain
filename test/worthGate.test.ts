import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendAssertionEvent, createAssertionEvent } from "../lib/assertionLog";
import { appendDeclineEvent, createDeclineEvent } from "../lib/declineLog";
import { tickIntegrationInclusion } from "../lib/inclusionStages";
import { accountFingerprint, accountPolicy, writeAccountPolicy } from "../lib/integrationAccess";
import { readSourceInsertionLog } from "../lib/insertionLog";
import { saveJevKey } from "../lib/jevSettings";
import { loadManifest, type GateConfig } from "../lib/manifest";
import { passStaged } from "../lib/stage";
import { stage, stagedItems, type StagedItem } from "../lib/stageStorage";
import { gateDecisions, gateThreshold, type GateDecision } from "../lib/worthGate";
import { NATIVE_YAML, nativeVault } from "./support/vault";

// All content here is invented.
const scratch: string[] = [];
afterAll(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const CFG: GateConfig = { sample: 0.05, recall: 0.98, min: 4, rule: "Worth recording.", sources: ["email"] };
const decision = (id: string, score: number, sampled = false): GateDecision =>
  ({ at: "2026-08-20T00:00:00.000Z", id, source: "email", title: id, score, threshold: 0, admitted: true, insertion_id: `ins_${id}`, ...(sampled ? { sampled } : {}) });

describe("the cut-off", () => {
  const kept = (ids: string[], declined: string[]) => new Map([...ids.map((i) => [`ins_${i}`, true] as const), ...declined.map((i) => [`ins_${i}`, false] as const)]);

  test("stays at 0 until the gardener has answered `min` scored items", () => {
    expect(gateThreshold(CFG, [decision("a", 0.9), decision("b", 0.1)], kept(["a"], ["b"]))).toBe(0);
  });

  test("rises to the highest value that still keeps `recall` of what the gardener filed", () => {
    const ds = [decision("k1", 0.3), decision("k2", 0.6), decision("k3", 0.9), decision("n1", 0.05), decision("n2", 0.2)];
    expect(gateThreshold(CFG, ds, kept(["k1", "k2", "k3"], ["n1", "n2"]))).toBe(0.3);
  });

  test("a sampled item stands for the ones under the cut-off that weren't sent", () => {
    const loose = { ...CFG, recall: 0.8 };
    const ds = (sampled: boolean) => [decision("low", 0.1, sampled), ...["a", "b", "c", "d", "e", "f", "g"].map((k, i) => decision(k, 0.3 + i * 0.1))];
    const filed = kept(["low", "a", "b", "c", "d", "e", "f", "g"], []);
    expect(gateThreshold(loose, ds(false), filed)).toBe(0.3); // one lost filing in eight is within 80%
    expect(gateThreshold(loose, ds(true), filed)).toBe(0.1); // but sampled, it stands for twenty
  });
});

describe("the gate in front of the gardener", () => {
  test("starts by admitting everything, learns from the gardener's verdicts, then passes what it would not keep", async () => {
    const account = "example@example.test";
    const yaml = `${NATIVE_YAML}integrations:\n  email:\n    inboxes:\n      - address: ${account}\n        host: imap.example.test\ngate:\n  min: 2\n`;
    const root = nativeVault({ prefix: "bb-gate-", files: { "vault.yaml": yaml, ".env": "BIGBRAIN_IMAP_PASSWORD__EXAMPLE_EXAMPLE_TEST=fictional\n" } });
    scratch.push(root);
    const store = join(root, "connections.json");
    const before = { conn: process.env["BIGBRAIN_SHARED_CONNECTIONS"], fetch: globalThis.fetch, random: Math.random };
    process.env["BIGBRAIN_SHARED_CONNECTIONS"] = store;
    // Jev, scripted: anything about the budget matters, the rest is noise
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { state: { source: { body: string } } };
      return new Response(JSON.stringify({ answers: { relevant: { type: "noul", noul: body.state.source.body.includes("budget") ? 0.9 : 0.1 } }, usage: { input_tokens: 1 } }));
    }) as typeof fetch;
    try {
      writeAccountPolicy(root, "email", account, { ...accountPolicy(root, "email", account), connected: true,
        fingerprint: accountFingerprint(root, "email", account), remembering: { enabled: true, rule: "Include everything." } });
      saveJevKey(store, "fictional");
      expect(loadManifest(root).gate).toMatchObject({ min: 2, sources: ["email"] });
      const item = (id: string, text: string): StagedItem => ({ id, source: "email", account, at: "2026-08-20T00:00:00.000Z", line: id, scopes: {}, name: `${id}.md`,
        content: `---\nid: ${id}\ntitle: Invented ${id}\nsource: email\nkind: email\ninbox: ${account}\n---\n${text}` });

      // cold start: the cut-off is 0, so both are admitted, scored and journaled
      stage(root, item("keep-1", "Briar confirmed the budget for the orrery repair."));
      stage(root, item("noise-1", "Ten percent off invented socks."));
      await tickIntegrationInclusion(root, store);
      expect(stagedItems(root, "email")).toHaveLength(0);
      expect(gateDecisions(root).map((d) => [d.id, d.score, d.admitted, !!d.insertion_id]).sort()).toEqual([["keep-1", 0.9, true, true], ["noise-1", 0.1, true, true]]);

      // the gardener files one and declines the other
      const sources = new Map(readSourceInsertionLog(root).map((s) => [s.id, s]));
      const idOf = (id: string) => gateDecisions(root).find((d) => d.id === id)!.insertion_id!;
      const meta = { author: { kind: "model" as const, id: "test", invocation_id: "run-1" }, created_at: "2026-08-21T00:00:00.000Z", produced_by: { procedure: "test", version: "v1" } };
      appendAssertionEvent(root, createAssertionEvent({ ...meta, text: "Briar confirmed the orrery repair budget.", entities: [], sources: [idOf("keep-1")], confidence: "direct" }, sources));
      appendDeclineEvent(root, createDeclineEvent({ ...meta, insertion_ids: [idOf("noise-1")], reason: "A promotion." }, sources));

      // now the cut-off has risen to what the gardener kept; noise is passed, not admitted
      Math.random = () => 0.99;
      stage(root, item("noise-2", "Another invented coupon."));
      await tickIntegrationInclusion(root, store);
      const passed = gateDecisions(root).at(-1)!;
      expect([passed.id, passed.score, passed.threshold, passed.admitted]).toEqual(["noise-2", 0.1, 0.9, false]);
      expect(stagedItems(root, "email")).toHaveLength(0);
      expect(readSourceInsertionLog(root).map((s) => s.title)).not.toContain("Invented noise-2");
      expect(readFileSync(join(root, ".spool", "stage", "passed.jsonl"), "utf8")).toContain("Under the worth gate's cut-off");

      // a few under the cut-off still go through, to check it
      Math.random = () => 0.01;
      stage(root, item("noise-3", "An invented raffle."));
      await tickIntegrationInclusion(root, store);
      expect(gateDecisions(root).at(-1)).toMatchObject({ id: "noise-3", admitted: true, sampled: true });

      // and nothing else may pass an include-everything item the gate didn't
      stage(root, item("keep-2", "The budget meeting moved to Friday."));
      expect(passStaged(root, ["keep-2"], "bypass")[0]!.ok).toBe(false);
    } finally {
      if (before.conn === undefined) delete process.env["BIGBRAIN_SHARED_CONNECTIONS"]; else process.env["BIGBRAIN_SHARED_CONNECTIONS"] = before.conn;
      globalThis.fetch = before.fetch;
      Math.random = before.random;
    }
  });
});
