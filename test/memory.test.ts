import { readMemoryInputs } from "../lib/memoryInputs";
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiLoader } from "./support/pi";
import { fakeMemoryPi as fakePi } from "./support/memoryPi";
import { gitOut } from "../lib/git";
import { runMemory } from "../lib/memoryRun";
import { readModelRuns } from "../lib/run/monitor";
import type { Manifest } from "../lib/manifest";
import { previousRunFailure } from "../lib/memoryContext";
import { MEMORY_MAX_FILES, MEMORY_MAX_WORDS, MEMORY_TRIM_ATTEMPTS } from "../lib/memoryTree";
import { labels, readLedger, recordSearch, recordUse } from "../lib/retrieval";
import {
  describeMemoryWork,
  hasMemoryWork,
  memoryDue,
  memoryLockDir,
  memoryRunning,
  memoryWork,
  readMemoryStamp,
  writeMemoryStamp,
} from "../lib/memory";
import {
  appendAssertionEvent,
  assertionEntityId,
  createAssertionEvent,
} from "../lib/assertionLog";
import { appendSourceInsertionEvent, type SourceInsertion } from "../lib/insertionLog";
import { gitVault, insertion, testManifest } from "./support/vault";

const freshRoot = (): string => mkdtempSync(join(tmpdir(), "bb-memory-"));
const P = { from: "nick", via: "cli:test" };

/** A VOICE arrival — the pass's settling input since #521 (the
 * observations spool it replaced went on 2026-08-30). Lands the insertion
 * event the readers actually read, with the envelope keys they consult. */
let obsSeq = 0;
function emitVoice(
  root: string,
  draft: { observation: string; query?: string; urgency?: "now"; now?: Date },
  principal: { from: string; via: string; from_kind?: string }
): SourceInsertion {
  obsSeq += 1;
  const at = (draft.now ?? new Date()).toISOString();
  const event = insertion({
    id: `ins_${String(obsSeq).padStart(24, "0")}`,
    source_id: `voice-${obsSeq}`,
    author: { kind: "person", id: principal.from },
    title: draft.observation.slice(0, 60),
    body: draft.observation,
    envelope: {
      kind: "observation",
      from: principal.from,
      submitted_via: principal.via,
      ...(principal.from_kind ? { from_kind: principal.from_kind } : {}),
      ...(draft.query ? { query: draft.query } : {}),
      ...(draft.urgency ? { urgency: draft.urgency } : {}),
    },
    received_at: at,
    content_sha256: `sha-voice-${obsSeq}`,
  });
  appendSourceInsertionEvent(root, event);
  return event;
}

/** A new assertion — the "record changed" half of the work gate. */
let astSeq = 0;
function seedAssertion(root: string, created: string): void {
  astSeq += 1;
  const src = insertion({
    id: `ins_9${String(astSeq).padStart(23, "0")}`,
    source_id: `src-${astSeq}`,
    author: { kind: "service", id: "granola" },
    title: `Meeting ${astSeq}`,
    body: "Ada said the Atlas experiment should test sparse probes.",
    envelope: { id: `src-${astSeq}` },
    received_at: created,
    content_sha256: `sha-src-${astSeq}`,
  });
  appendSourceInsertionEvent(root, src);
  const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
  appendAssertionEvent(
    root,
    createAssertionEvent(
      {
        text: `[[${ada.id}|Ada]] wants sparse probes tested (${astSeq}).`,
        entities: [ada],
        sources: [src.id],
        author: { kind: "model", id: "claude-test", invocation_id: "run-1" },
        confidence: "direct",
        created_at: created,
        produced_by: { procedure: "intake-agent", version: "v1" },
      },
      new Map([[src.id, src]])
    )
  );
}

describe("memoryDue — the pass's own due-check (never a sleep)", () => {
  test("a vault with no stamp is never auto-due; --force always is", () => {
    const root = freshRoot();
    expect(memoryDue(root).due).toBe(false);
    expect(memoryDue(root, { force: true })).toEqual({
      due: true,
      reason: "forced",
    });
  });

  test("scheduled sweep: due exactly when nextRunAt arrives — given work to do", () => {
    const root = freshRoot();
    const now = new Date("2026-08-05T12:00:00Z");
    writeMemoryStamp(root, { nextRunAt: "2026-08-05T12:30:00Z" });
    seedAssertion(root, "2026-08-05T11:00:00.000Z");
    expect(memoryDue(root, { now }).due).toBe(false);
    expect(memoryDue(root, { now: new Date("2026-08-05T12:30:01Z") }).due).toBe(
      true
    );
  });

  test("the work gate: an arrived sweep with nothing to fold in does NOT run", () => {
    const root = freshRoot();
    const now = new Date("2026-08-05T13:00:00Z");
    // sweep time long past, but nothing sits past the cursors — a model
    // asked to consolidate nothing would rewrite a tree that was already
    // right
    seedAssertion(root, "2026-08-05T11:00:00.000Z");
    const folded = memoryWork(root, {});
    writeMemoryStamp(root, {
      nextRunAt: "2026-08-05T12:00:00Z",
      assertionCursor: { at: "2026-08-05T11:00:00.000Z", id: "\uffff" },
    });
    expect(folded.record).toBe(1); // it was work, before the cursor moved past it
    const v = memoryDue(root, { now });
    expect(v.due).toBe(false);
    expect(v.reason).toMatch(/nothing to fold in/);
    // one new assertion past the cursor flips it
    seedAssertion(root, "2026-08-05T12:30:00.000Z");
    expect(memoryDue(root, { now }).due).toBe(true);
  });

  test("--force overrides the work gate (an explicit run is intent, not inference)", () => {
    const root = freshRoot();
    writeMemoryStamp(root, { nextRunAt: "2026-08-05T12:00:00Z" });
    expect(
      memoryDue(root, { force: true, now: new Date("2026-08-05T13:00:00Z") })
        .due
    ).toBe(true);
  });

  test("voice arrivals are work, not a trigger: they wait for the sweep (2026-09-02)", () => {
    const root = freshRoot();
    writeMemoryStamp(root, { nextRunAt: "2026-08-06T00:00:00Z" }); // sweep tomorrow
    emitVoice(root, { observation: "fresh why", now: new Date("2026-08-05T12:00:00Z") }, P);
    // hours later, still waiting — there is no settle clock any more
    const waiting = memoryDue(root, { now: new Date("2026-08-05T18:00:00Z") });
    expect(waiting.due).toBe(false);
    expect(waiting.reason).toBe("next sweep not yet due (1 voice note(s) waiting)");
    // the sweep folds it in
    const swept = memoryDue(root, { now: new Date("2026-08-06T00:00:01Z") });
    expect(swept.due).toBe(true);
    expect(swept.reason).toBe("scheduled sweep — 1 voice note(s)");
  });

  test("the view's work count IS the gate's — one function, no drift", () => {
    const root = freshRoot();
    seedAssertion(root, "2026-08-05T11:00:00.000Z");
    const stamp = {
      nextRunAt: "2026-08-05T12:00:00Z",
      assertionCursor: { at: "2026-08-05T11:00:00.000Z", id: "\uffff" },
      insertionCursor: { at: "2026-08-05T11:00:00.000Z", id: "\uffff" },
    };
    writeMemoryStamp(root, stamp);
    expect(hasMemoryWork(memoryWork(root, stamp))).toBe(false);
    expect(memoryDue(root, { now: new Date("2026-08-05T13:00:00Z") }).due).toBe(
      false
    );

    seedAssertion(root, "2026-08-05T12:30:00.000Z");
    emitVoice(root, { observation: "why", now: new Date("2026-08-05T12:40:00Z") }, P);
    const w = memoryWork(root, stamp);
    expect({ voice: w.voice.length, record: w.record }).toEqual({ voice: 1, record: 1 });
    expect(describeMemoryWork(w)).toBe("1 voice note(s) + 1 new assertion(s)");
    expect(memoryDue(root, { now: new Date("2026-08-05T13:00:00Z") }).due).toBe(
      true
    );
  });

  test("stamps round-trip", () => {
    const root = freshRoot();
    writeMemoryStamp(root, { lastRunAt: "a", nextRunAt: "b", run: "c" });
    expect(readMemoryStamp(root)).toEqual({ lastRunAt: "a", nextRunAt: "b", run: "c" });
  });
});

// ══════════════════════════════════════════════════════════════════════
// `urgency: now` (2026-08-05, Nick: "build --now") used to collapse an
// arrival's settle so the next tick swept. Retired 2026-09-02 with the
// settle clock itself (Nick: "voice notes should be tended just like
// everything else"): the field still lands — old events carry it — and
// the pass no longer reads it.
// ══════════════════════════════════════════════════════════════════════
describe("urgency now — inert since 2026-09-02", () => {
  test("an urgent arrival waits for the sweep like every other voice note", () => {
    const root = freshRoot();
    writeMemoryStamp(root, {
      checkpoint: readMemoryInputs(root).checkpoint,
      lastRunAt: "2026-08-05T00:00:00Z",
      nextRunAt: "2026-08-06T00:00:00Z",
    });
    emitVoice(
      root,
      {
        observation: "correct the advising note",
        urgency: "now",
        now: new Date("2026-08-05T12:00:00Z"),
      },
      P
    );
    const verdict = memoryDue(root, { now: new Date("2026-08-05T12:01:00Z") });
    expect(verdict.due).toBe(false);
    expect(verdict.reason).toBe("next sweep not yet due (1 voice note(s) waiting)");
    expect(memoryDue(root, { now: new Date("2026-08-06T00:00:00Z") }).due).toBe(true);
  });
});

describe("memoryRunning — the viewer's spinner reads the lock, never guesses", () => {
  test("no lock: not running", () => {
    expect(memoryRunning(freshRoot())).toBe(false);
  });

  test("a lock held by a live pid IS running", () => {
    const root = freshRoot();
    mkdirSync(memoryLockDir(root), { recursive: true });
    writeFileSync(join(memoryLockDir(root), "pid"), `${process.pid}\n`);
    expect(memoryRunning(root)).toBe(true);
  });

  test("a stale lock (dead pid, or no pid file at all) never reads as running", () => {
    const root = freshRoot();
    mkdirSync(memoryLockDir(root), { recursive: true });
    expect(memoryRunning(root)).toBe(false); // legacy lock, no pid file
    writeFileSync(join(memoryLockDir(root), "pid"), "999999999\n");
    expect(memoryRunning(root)).toBe(false); // crashed holder
  });
});

// ══════════════════════════════════════════════════════════════════════
// runMemory — the pass end-to-end. bin/memory.ts was a top-level script,
// so importing anything from it EXECUTED a sweep and this suite could not
// exist; the body moved to lib/memoryRun.ts (2026-08-07) precisely so it
// could. The model is stubbed at the spawn seam — what is under test is
// the RUNNER's mechanical contract, which is the half that is not a guess.
// ══════════════════════════════════════════════════════════════════════
describe("runMemory: the mechanical contract", () => {
  /** A real git repo with a seeded memory tree (git: the pass commits). */
  function memVault(): string {
    return gitVault({
      prefix: "bb-memory-",
      dirs: ["memory", "prompts", "entities", "journal/memory", ".state"],
      files: {
        "prompts/memory.md": "MEMORY PASS TEMPLATE\n",
        "entities/evan-keller.md": "---\ntitle: Evan\n---\n\nx\n",
        "memory/MEMORY.md": "# Memory index\n\n- [[memory/fri-work|FRI work]]\n",
        "memory/fri-work.md": "---\ntitle: FRI\n---\n\nunder [[entities/evan-keller|Evan]]\n",
      },
      identity: { name: "t", email: "t@t" },
      commit: "seed",
    });
  }

  const memManifest = (root: string): Manifest =>
    testManifest(root, {
      memory: {
        adapter: "pi", provider: "anthropic",
        model: "claude-m",
        interval: "3h",
        intervalMs: 1,
      },
    });

  /** A stub that performs `write` against the vault, then reports. */
  const memoryModel = (write: () => void): PiLoader =>
    fakePi(() => {
      write();
      return { result: "```report\ndid it\n```\n" };
    });

  const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");
  const run = (root: string, write: () => void) =>
    runMemory({ root, manifest: memManifest(root), force: true, loadPi: memoryModel(write) });

  test("a renamed topic drags its siblings' links with it — the hole memory→memory linking opened", async () => {
    const root = memVault();
    const res = await run(root, () => {
      renameSync(join(root, "memory", "fri-work.md"), join(root, "memory", "forecasting.md"));
    });
    expect(res.error).toBeUndefined();
    expect(res.movesFollowed).toBe(1);
    // the index pointed at the old name and the model never touched it
    expect(read(root, "memory/MEMORY.md")).toContain("[[memory/forecasting|FRI work]]");
  });

  test("the model may write a bare or markdown link; the tree keeps canonical ones", async () => {
    const root = memVault();
    const res = await run(root, () => {
      writeFileSync(
        join(root, "memory", "MEMORY.md"),
        "# Memory index\n\n- [FRI work](fri-work.md) — load this\n- run by [[evan-keller]]\n"
      );
    });
    expect(res.error).toBeUndefined();
    const body = read(root, "memory/MEMORY.md");
    expect(body).toContain("[[memory/fri-work|FRI work]]"); // markdown → wikilink
    expect(body).toContain("[[entities/evan-keller|evan-keller]]"); // bare → path
    expect(res.canonicalized).toBe(2);
  });

  test("an over-budget run is reverted and never rewritten — order matters", async () => {
    const root = memVault();
    const res = await run(root, () => {
      for (let i = 0; i < MEMORY_MAX_FILES + 2; i++)
        writeFileSync(
          join(root, "memory", `t${i}.md`),
          `---\ntitle: t${i}\n---\n\n[[evan-keller]]\n`
        );
    });
    expect(res.error).toContain("over budget");
    expect(res.canonicalized).toBe(0); // the rewriters never saw the doomed tree
    expect(existsSync(join(root, "memory", "t0.md"))).toBe(false);
  });

  test("the journal records the rewrites — the record differs from what the model wrote", async () => {
    const root = memVault();
    const res = await run(root, () => {
      writeFileSync(
        join(root, "memory", "fri-work.md"),
        "---\ntitle: FRI\n---\n\nunder [[evan-keller]]\n"
      );
    });
    const journal = JSON.parse(read(root, `journal/memory/${res.run}.json`));
    expect(journal.canonicalized).toBe(1);
    expect(journal.report).toBe("did it");
  });

  test("concurrent tracked edits and new arrivals stay exactly where they landed", async () => {
    const root = memVault();
    const res = await run(root, () => {
      writeFileSync(join(root, "entities", "evan-keller.md"), "Concurrent edit\n");
      mkdirSync(join(root, "queue", "pending"), { recursive: true });
      for (let i = 0; i < 10; i++) writeFileSync(join(root, "queue", "pending", `q-${i}.yaml`), `id: q-${i}\n`);
      recordSearch(root, "fixture query", ["entities/evan-keller.md"], "web");
      recordUse(root, "entities/evan-keller.md", "web");
    });
    expect(res.error).toBeUndefined();
    expect(read(root, "entities/evan-keller.md")).toBe("Concurrent edit\n");
    for (let i = 0; i < 10; i++) expect(read(root, `queue/pending/q-${i}.yaml`)).toBe(`id: q-${i}\n`);
    expect(existsSync(join(root, "journal", "violations"))).toBe(false);
    expect(readModelRuns(root, "2000")[0]!.phase).toBe("completed");
    expect(labels(readLedger(root))[0]!.q).toBe("fixture query");
    expect(gitOut(root, ["status", "--porcelain", "--", "journal/retrieval"])).toBe("");
  });


  test("not due is not a run — the model is never spawned", async () => {
    const root = memVault();
    writeMemoryStamp(root, {
      lastRunAt: new Date().toISOString(),
      nextRunAt: new Date(Date.now() + 9_000_000).toISOString(),
    });
    const res = await runMemory({
      root,
      manifest: memManifest(root),
      loadPi: fakePi(() => {
        throw new Error("must not spawn");
      }),
    });
    expect(res.ran).toBe(false);
  });

  // ── a failed run takes the interval's slot (2026-09-03) ───────────────
  // The stamp used to be written only on success, so a failure left
  // nextRunAt in the past and the next five-minute tick was due again: a
  // run that died at the timeout, or a tree still over budget after its
  // trims, re-ran and re-paid every tick until something changed.
  describe("a failed run takes the interval's slot", () => {
    const DAY = 86_400_000;
    const onTheClock = {
      lastRunAt: "2026-09-01T12:00:00.000Z",
      nextRunAt: "2026-09-02T12:00:00.000Z",
      lastCommit: "abc123",
      run: "2026-09-01T12-00-00-000Z-aaaa",
      assertionCursor: { at: "2026-09-01T11:00:00.000Z", id: "ast_1" },
      insertionCursor: { at: "2026-09-01T11:30:00.000Z", id: "ins_1" },
    };
    const fell = fakePi(() => {
      throw new Error("claude fell over");
    });
    const daily = (root: string): Manifest =>
      testManifest(root, { memory: { adapter: "pi", provider: "anthropic", model: "claude-m", interval: "1d", intervalMs: DAY } });

    test("only the clock moves — the cursors, lastRunAt, lastCommit and run still name the last fold", async () => {
      const root = memVault();
      writeMemoryStamp(root, onTheClock);
      const before = Date.now();
      const res = await runMemory({ root, manifest: daily(root), force: true, loadPi: fell });
      expect(res.error).toBe("claude fell over");
      const stamp = readMemoryStamp(root);
      expect(Date.parse(stamp.nextRunAt!)).toBeGreaterThanOrEqual(before + DAY);
      const { nextRunAt: _moved, ...rest } = stamp;
      const { nextRunAt: _old, ...was } = onTheClock;
      expect(rest).toEqual(was);
      // the journal is the record of the failure; the retry reads it
      expect(previousRunFailure(root)).toEqual({
        run: res.run!,
        at: expect.any(String),
        error: "claude fell over",
      });
    });

    test("a vault not yet on the clock stays off it — a failed first --force writes no stamp", async () => {
      const root = memVault();
      const res = await runMemory({ root, manifest: daily(root), force: true, loadPi: fell });
      expect(res.error).toBe("claude fell over");
      expect(readMemoryStamp(root)).toEqual({});
      expect(memoryDue(root).reason).toBe("no stamp — first run is --force");
    });
  });

  // ── #598: the budget is a loop, not a cliff ───────────────────────────
  // The model counts exactly (it runs `wc`) and used to be reverted at
  // 3,300 after being told "roughly 3,000": it submitted 6–23% over run
  // after run, each revert cost $1–4, and the retry saw the same prompt
  // and tree. Now an over-budget tree goes BACK with the measured overage.
  describe("#598 — over budget goes back to the model, not to the floor", () => {
    /** One scripted turn per model call; every prompt captured. */
    const turns = (steps: ((prompt: string) => void)[]) => {
      const prompts: string[] = [];
      const loadPi = fakePi((prompt) => {
        const i = prompts.length;
        prompts.push(prompt);
        const step = steps[i];
        if (!step) throw new Error(`unexpected model call #${i + 1}`);
        step(prompt);
        return {
            result: `\`\`\`report\nturn ${i + 1}\n\`\`\`\n`,
            total_cost_usd: 1,
            num_turns: 2,
            usage: { input_tokens: 10, output_tokens: 5 },
          };
      });
      return { loadPi, prompts };
    };
    const prose = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    /** fri-work.md at `n` words of body — 4 more for its frontmatter, and
     * MEMORY.md's 6 on top: the tree measures n + 10. */
    const bloat = (root: string, n: number): void =>
      writeFileSync(join(root, "memory", "fri-work.md"), `---\ntitle: FRI\n---\n\n${prose(n)}\n`);
    const go = (root: string, loadPi: PiLoader) =>
      runMemory({ root, manifest: memManifest(root), force: true, loadPi });

    test("the tree is handed back with the measured overage, and the trimmed run commits", async () => {
      const root = memVault();
      const { loadPi, prompts } = turns([() => bloat(root, 3400), () => bloat(root, 2900)]);
      const res = await go(root, loadPi);
      expect(res.error).toBeUndefined();
      expect(res.committed).toBe(true);
      expect(res.trims).toBe(1);
      expect(res.words).toBe(2910);
      expect(prompts).toHaveLength(2);
      const trim = prompts[1]!;
      expect(trim).toContain(`trim turn 1 of ${MEMORY_TRIM_ATTEMPTS}`);
      expect(trim).toContain("now: 3410 words in 2 files");
      expect(trim).toContain(`cut: at least ${3410 - MEMORY_MAX_WORDS} words`);
      expect(trim).toContain("- memory/fri-work.md — 3404 words");
      expect(trim).toContain("- memory/MEMORY.md — 6 words");
      expect(trim).toContain("turn 1"); // the run's own report rides along
      const journal = JSON.parse(read(root, `journal/memory/${res.run}.json`));
      expect(journal.trims).toEqual([
        expect.objectContaining({
          attempt: 1,
          before: { files: 2, words: 3410 },
          after: { files: 2, words: 2910 },
          usage: expect.objectContaining({ cost_usd: null, turns: 1 }),
        }),
      ]);
      // the trim's spend is the run's spend — econ sums `usage`
      expect(journal.usage).toMatchObject({ cost_usd: null, turns: 2, input_tokens: 20 });
      expect(journal.tree).toEqual({ files: 2, words: 2910 });
      expect(journal.report).toContain("## Trim 1");
      expect(journal.report).toContain("turn 2");
    });

    test(`still over after ${MEMORY_TRIM_ATTEMPTS} trims → reverted, and the next run is told`, async () => {
      const root = memVault();
      const { loadPi, prompts } = turns([
        () => bloat(root, 3400),
        () => bloat(root, 3350),
        () => bloat(root, 3320),
        () => bloat(root, 100), // never reached
      ]);
      const res = await go(root, loadPi);
      expect(prompts).toHaveLength(1 + MEMORY_TRIM_ATTEMPTS);
      expect(res.error).toBe(
        `over budget: 2 file(s) (max ${MEMORY_MAX_FILES}), 3330 word(s) (max ${MEMORY_MAX_WORDS}) after ${MEMORY_TRIM_ATTEMPTS} trim turn(s) — run reverted`
      );
      expect(res.trims).toBe(MEMORY_TRIM_ATTEMPTS);
      expect(read(root, "memory/fri-work.md")).toContain("under [[entities/evan-keller|Evan]]");
      expect(prompts[2]).toContain(`trim turn 2 of ${MEMORY_TRIM_ATTEMPTS}`);
      expect(prompts[2]).toContain("now: 3360 words");
      // the journal keeps what each turn was asked and what it did
      const journal = JSON.parse(read(root, `journal/memory/${res.run}.json`));
      expect(journal.trims.map((t: { after: { words: number } }) => t.after.words)).toEqual([
        3360, 3330,
      ]);
      expect(journal.tree).toEqual({ files: 2, words: 3330 });

      // the retry is not blind: it is told the last run died, and where the tree stands
      const again = turns([() => {}]);
      const res2 = await go(root, again.loadPi);
      expect(res2.error).toBeUndefined();
      const ctx = again.prompts[0]!;
      expect(ctx).toContain(`The previous run (${res.run}) was discarded — over budget:`);
      expect(ctx).toContain(
        `The tree stands at 12 words in 2 files now — ${MEMORY_MAX_WORDS - 12} words of headroom.`
      );
      expect(ctx).toContain(`${MEMORY_MAX_WORDS} words and ${MEMORY_MAX_FILES} files`);
      // …and a run that succeeded says nothing about a previous one
      const third = turns([() => {}]);
      await go(root, third.loadPi);
      expect(third.prompts[0]).not.toContain("previous run");
    });

    test("concurrent arrivals during a trim turn remain untouched", async () => {
      const root = memVault();
      const { loadPi } = turns([
        () => bloat(root, 3400),
        () => {
          bloat(root, 2900);
          writeFileSync(join(root, "entities", "stray.md"), "the model wandered\n");
        },
      ]);
      const res = await go(root, loadPi);
      expect(res.error).toBeUndefined();
      expect(res.committed).toBe(true);
      expect(read(root, "entities/stray.md")).toBe("the model wandered\n");
    });

    test("a trim turn that fails leaves nobody to fix a known-over tree — reverted", async () => {
      const root = memVault();
      const { loadPi, prompts } = turns([
        () => bloat(root, 3400),
        () => {
          throw new Error("claude fell over");
        },
      ]);
      const res = await go(root, loadPi);
      expect(prompts).toHaveLength(2);
      expect(res.error).toMatch(/^trim 1 failed: claude fell over — run reverted$/);
      expect(res.trims).toBe(0);
      expect(read(root, "memory/fri-work.md")).toContain("under [[entities/evan-keller|Evan]]");
      expect(gitOut(root, ["status", "--porcelain", "--", "memory"])).toBe("");
    });

    test("a tree under the line never sees a trim turn, and the context carries the line", async () => {
      const root = memVault();
      const { loadPi, prompts } = turns([() => bloat(root, 3000)]);
      const res = await go(root, loadPi);
      expect(res.error).toBeUndefined();
      expect(res.trims).toBe(0);
      expect(res.words).toBe(3010);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("aim for 3000 words or fewer");
      expect(prompts[0]).toContain("trimming attempts before discarding an oversized result.");
      const journal = JSON.parse(read(root, `journal/memory/${res.run}.json`));
      expect(journal.trims).toBeUndefined();
      expect(journal.tree).toEqual({ files: 2, words: 3010 });
      expect(journal.usage).toMatchObject({ cost_usd: null, turns: 1 });
    });
  });
});
