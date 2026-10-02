import { fakeIntegrationActivation } from "./support/integrationActivation";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAssertionLock, releaseAssertionLock } from "../lib/assertionAgent";
import type { PiLoader } from "./support/pi";
import type { Options } from "./support/pi";
import { fakePi } from "./support/pi";
import type { SourceInsertion } from "../lib/insertionLog";
import type { Manifest } from "../lib/manifest";
import type { MemoryRunResult } from "../lib/memoryRun";
import { stagedIds } from "../lib/stage";
import { stage } from "../lib/stageStorage";
import { runTend, tendDue, tendHasWork, tendPrompt } from "../lib/tend";
import { dueIntakeIds, submitWork } from "../lib/work";
import { insertionSeq, nativeVault, NATIVE_YAML } from "./support/vault";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const insertion = insertionSeq();

const vault = (...insertions: SourceInsertion[]): string => {
  const root = nativeVault({ prefix: "bb-tend-", insertions, files: { "vault.yaml": NATIVE_YAML } });
  scratch.push(root);
  return root;
};

const manifest = (root: string, over: Partial<Manifest> = {}): Manifest => ({
  root,
  auth: "max",
  integrations: {},
  gardener: { adapter: "pi", provider: "anthropic", model: "claude-opus-5" },
  memory: {
    adapter: "pi", provider: "anthropic",
    model: "claude-opus-5",
    interval: "1d", intervalMs: 86_400_000,
  },
  ...over,
});

/** A stub model that SETTLES: submits one decline per due insertion, the
 * way a real gardener session would through the MCP server. */
const settlingModel =
  (root: string, ids: () => string[], calls: Array<{ prompt: string; options: Options }>): PiLoader =>
  fakePi((prompt, options) => {
    calls.push({ prompt, options });
    const due = ids();
    if (due.length)
      submitWork(root, [{ submit: "decline", insertion_ids: [due[0]!], reason: "test settle" }], {
        author: { kind: "model", id: "stub", invocation_id: "t" },
        produced_by: { procedure: "test", version: "v1" },
      });
    return {
        result: "done", total_cost_usd: 0.05, num_turns: 4,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 },
      };
  });

// the same question the runner asks, through the same function (#640)
const liveDue = (root: string) => (): string[] => dueIntakeIds(root);

describe("containment", () => {
  test("the session uses an isolated cwd and role-scoped tools; auth max strips the key", async () => {
    const a = insertion();
    const root = vault(a);
    const calls: Array<{ prompt: string; options: Options }> = [];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    const result = await runTend({ root, manifest: manifest(root), loadPi: settlingModel(root, liveDue(root), calls) });
    expect(result.ran).toBe(true);
    expect(calls.length).toBe(1);
    const { prompt, options: opts } = calls[0]!;
    expect(opts.cwd).not.toBe(root);
    expect(opts.cwd).toContain("pilot-engines");
    expect(opts.tools).toEqual(["search_vault", "read_note", "next", "open", "submit", "read_intake"]);
    expect(opts.resourceLoader?.getExtensions().extensions).toEqual([]);
    expect(opts.settingsManager?.getRetrySettings().enabled).toBe(false);
    expect(prompt).toContain("gardener");
  });

  test("provider failures are journaled and the run fails", async () => {
    const root = vault(insertion());
    const result = await runTend({ root, manifest: manifest(root), loadPi: fakePi(() => { throw new Error("Fixture connection unavailable"); }) });
    expect(result.rounds[0]!.error).toContain("Fixture connection unavailable");
  });
});

describe("the loop", () => {
  test("rounds drain the backlog; each round journals; the journal is meter-shaped", async () => {
    const a = insertion();
    const b = insertion();
    const root = vault(a, b);
    const calls: Array<{ prompt: string; options: Options }> = [];
    const result = await runTend({ root, manifest: manifest(root), loadPi: settlingModel(root, liveDue(root), calls) });
    // one settle per round → two rounds, then due is empty
    expect(result.rounds.map((r) => r.settled)).toEqual([1, 1]);
    expect(result.rounds[1]!.remaining).toBe(0);
    const months = readdirSync(join(root, "journal", "tend"));
    expect(months.length).toBe(1);
    const files = readdirSync(join(root, "journal", "tend", months[0]!));
    expect(files.length).toBe(2);
    const j = JSON.parse(readFileSync(join(root, "journal", "tend", months[0]!, files[0]!), "utf8"));
    expect(j.format).toBe("bigbrain-tend-run/v1");
    expect(j.engine).toBe("pi");
    expect(j.sampling).toBe("pi-defaults");
    expect(j.usage.cost_usd).toBeNull(); // subscription usage has no API charge
    // #640: one usage shape for both spawns, so the tend journal spells
    // cache reads the way every other journal does. lib/meter.ts reads the
    // old key too, for records already on disk.
    expect(j.usage.cache_read_tokens).toBe(1000);
    expect(j.insertion_ids.length).toBe(1);
  });

  test("a no-progress round ends the run after one wasted call", async () => {
    const root = vault(insertion(), insertion());
    let calls = 0;
    const idle = fakePi(() => {
      calls += 1;
      return { result: "did nothing" };
    });
    const result = await runTend({ root, manifest: manifest(root), loadPi: idle });
    expect(calls).toBe(1);
    expect(result.rounds.length).toBe(1);
    expect(result.rounds[0]!.settled).toBe(0);
  });

  test("a staged head alone is due work: the round runs, an admit + decline settles it, the journal names both (#744)", async () => {
    const root = vault();
    fakeIntegrationActivation(root);
    stage(root, {
      id: "email-00000000000000000001", source: "email", at: "2026-09-04T10:00:00.000Z",
      line: '2026-09-04 · Evan <evan@fri.example.org> · "Re: timing" · 4k', scopes: { sender: "evan@fri.example.org" },
      name: "re-timing.md", content: "---\nid: email-00000000000000000001\nkind: email\ntitle: \"Re: timing\"\n---\nFriday works.\n",
    });
    expect(tendDue(root)).toEqual({ intake: 0, staged: 1, memory: false });
    // the CLI's gate must count it — 0.1.40 shipped `intake || memory` and a
    // stage with nothing else due never got a round
    expect(tendHasWork(tendDue(root))).toBe(true);
    expect(tendHasWork({ intake: 0, staged: 0, memory: false })).toBe(false);
    const admitting = fakePi(() => {
      // the way a real session would, through the MCP server: admit, then
      // settle the insertion the admit answered, in one submit
      const r = submitWork(root, [{ submit: "admit", staged_ids: stagedIds(root) }], {
        author: { kind: "model", id: "stub", invocation_id: "t" }, produced_by: { procedure: "test", version: "v1" },
      });
      const insertionId = (r.results[0]!.staged![0] as { insertion_id: string }).insertion_id;
      submitWork(root, [{ submit: "decline", insertion_ids: [insertionId], reason: "test settle" }], {
        author: { kind: "model", id: "stub", invocation_id: "t" }, produced_by: { procedure: "test", version: "v1" },
      });
      return { result: "done", total_cost_usd: 0.01, num_turns: 3, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const result = await runTend({ root, manifest: manifest(root), loadPi: admitting });
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]).toMatchObject({ settled: 1, remaining: 0 });
    expect(tendDue(root)).toEqual({ intake: 0, staged: 0, memory: false });
    const months = readdirSync(join(root, "journal", "tend"));
    const files = readdirSync(join(root, "journal", "tend", months[0]!));
    const j = JSON.parse(readFileSync(join(root, "journal", "tend", months[0]!, files[0]!), "utf8"));
    expect(j.prompt_version).toBe("tend/v3");
    expect(j.staged_ids).toEqual(["email-00000000000000000001"]);
    expect(j.insertion_ids).toEqual([]); // the admitted insertion was not due when the round began
  });

  test("single-flight: a held lock skips with a reason, no error", async () => {
    const root = vault(insertion());
    expect(acquireAssertionLock(root)).toBe(true);
    try {
      const result = await runTend({ root, manifest: manifest(root), loadPi: fakePi(() => { throw new Error("unreachable"); }) });
      expect(result.ran).toBe(false);
      expect(result.reason).toContain("lock");
    } finally {
      releaseAssertionLock(root);
    }
  });

  test("a non-native vault runs no intake rounds but still tends memory (forced first run)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-tend-legacy-"));
    scratch.push(root);
    writeFileSync(join(root, "vault.yaml"), "{}\n");
    let memoryRan = false;
    const m = { ...manifest(root), assertionNative: false };
    const result = await runTend({
      root, manifest: m, force: true,
      loadPi: fakePi(() => { throw new Error("no intake calls expected"); }),
      memoryRunner: async (opts) => {
        memoryRan = true;
        expect(opts.force).toBe(true);
        return { ran: true } as MemoryRunResult;
      },
    });
    expect(result.rounds).toEqual([]);
    expect(memoryRan).toBe(true);
    expect(result.memory?.ran).toBe(true);
  });

  test("memory does not run when not due; tendDue reports both gates", async () => {
    const a = insertion();
    const root = vault(a);
    const m = manifest(root);
    expect(tendDue(root)).toEqual({ intake: 1, staged: 0, memory: false });
    let memoryRan = false;
    await runTend({
      root, manifest: m, loadPi: settlingModel(root, liveDue(root), []),
      memoryRunner: async () => {
        memoryRan = true;
        return { ran: true } as MemoryRunResult;
      },
    });
    expect(memoryRan).toBe(false);
  });
});

describe("the prompt", () => {
  test("renders with owner labels, and the ENGINE's template is the only one", () => {
    const root = vault();
    const p = tendPrompt(["Alex Rowan", "demo-user"]);
    expect(p).toContain("Alex Rowan, demo-user");
    expect(p).toContain("submit");
    expect(p).not.toContain("{{");
    // A vault copy used to win here. That is what let a `memory.md` frozen
    // at 2026-08-28 outlive four engine fixes on the vault it was curating:
    // seeding stopped in #524, but the readers kept preferring whatever a
    // vault already held, and nothing shed it. One source of prompt text now.
    mkdirSync(join(root, "prompts"), { recursive: true });
    writeFileSync(join(root, "prompts", "tend.md"), "CUSTOM {{OWNER}}\n");
    expect(tendPrompt([])).not.toContain("CUSTOM");
  });
});
