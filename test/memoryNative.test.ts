// ══════════════════════════════════════════════════════════════════════
// The memory pass's assertion-era inputs (#459, decided 2026-08-21 in
// docs/plans/2026-08-21-memory-assertion-inputs.md). What is under test is
// the three mechanical halves of that decision: due-ness moves to cursors
// over the assertion log (raw arrivals deliberately do NOT trigger), the
// prompt's delta blocks render from the logs, and the citation gate
// treats an unresolvable [[ast_…]] like an over-budget tree — wholesale
// revert, loud failure. Legacy vaults must be untouched by all of it.
// ══════════════════════════════════════════════════════════════════════
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Manifest } from "../lib/manifest";
import { fakePi as scriptedPi, type PiLoader } from "./support/pi";
import { fakeMemoryPi as fakePi } from "./support/memoryPi";
import {
  appendAssertionEvent,
  assertionEntityId,
  createAssertionEvent,
  type AssertionEvent,
} from "../lib/assertionLog";
import { appendSourceInsertionEvent, type SourceInsertion } from "../lib/insertionLog";
import { runMemory, type MemoryRunResult } from "../lib/memoryRun";
import { MEMORY_MAX_ASSERTIONS_INLINE, readMemorySnapshot } from "../lib/memoryContext";
import { memoryStanding, memoryLine } from "../lib/diagnostics";
import { readMemoryInputs } from "../lib/memoryInputs";
import { supersedeEntity } from "../lib/entitySupersede";
import { appendRevocationEvent, createRevocationEvent } from "../lib/revocationLog";
import { appendEntityAliasEvent, createEntityAliasEvent } from "../lib/entityAliasLog";
import {
  assertionAt,
  describeMemoryWork,
  hasMemoryWork,
  insertionAt,
  memoryDue,
  memoryNeedsRebuild,
  MEMORY_PROTOCOL_VERSION,
  memoryWork,
  readMemoryStamp,
  writeMemoryStamp,
  type MemoryStamp,
} from "../lib/memory";
import { gitVault, insertion, testManifest } from "./support/vault";

// ── fixtures ────────────────────────────────────────────────────────────

const at = (n: number): string => new Date(Date.UTC(2026, 7, 18, 10, 0, n)).toISOString();

const mkSource = (n: number) => insertion({
  id: `ins_${String(n).padStart(24, "0")}`,
  source_id: `src-${n}`,
  author: { kind: "service", id: "granola" },
  title: `Meeting ${n}`,
  body: "Ada said the Atlas experiment should test sparse probes.",
  envelope: { id: `src-${n}` },
  received_at: at(n),
  content_sha256: `sha-${n}`,
});

const mkAssertion = (src: SourceInsertion, text: string, created: string): AssertionEvent => {
  const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
  return createAssertionEvent(
    {
      text: `[[${ada.id}|Ada]] ${text}`,
      entities: [ada],
      sources: [src.id],
      author: { kind: "model", id: "claude-test", invocation_id: "run-1" },
      confidence: "direct",
      created_at: created,
      produced_by: { procedure: "intake-agent", version: "v1" },
    },
    new Map([[src.id, src]])
  );
};

const commitAll = (root: string, msg = "events"): void => {
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", msg], { cwd: root });
};

const SEED_INDEX = "# Memory\n\nstanding context\n";

/** A committed git vault carrying `n` insertion+assertion pairs (assertion
 * i cites insertion i, created one second apart in reader order) and — by
 * default — a seeded, citation-free memory tree. */
function nativeVault(
  n: number,
  opts: { tree?: boolean } = {}
): { root: string; sources: SourceInsertion[]; asts: AssertionEvent[] } {
  const root = gitVault({
    prefix: "bb-memnative-",
    dirs: ["memory", "prompts", "journal/memory", "observations/pending", ".state"],
    files: {
      "prompts/memory.md": "MEMORY PASS TEMPLATE\n",
      ...(opts.tree === false
        ? {}
        : {
            "memory/MEMORY.md": SEED_INDEX,
          }),
    },
    identity: { name: "t", email: "t@t" },
    commit: "seed",
  });
  const sources: SourceInsertion[] = [];
  const asts: AssertionEvent[] = [];
  for (let i = 0; i < n; i++) {
    const s = mkSource(i);
    appendSourceInsertionEvent(root, s);
    const a = mkAssertion(s, `noted fact number ${i} about the Atlas run.`, at(i));
    appendAssertionEvent(root, a);
    sources.push(s);
    asts.push(a);
  }
  commitAll(root);
  return { root, sources, asts };
}

const cursorAt = (e: AssertionEvent) => ({ at: assertionAt(e), id: e.id });
const insCursorAt = (s: SourceInsertion) => ({ at: insertionAt(s), id: s.id });

const memManifest = (root: string): Manifest =>
  testManifest(root, {
    memory: {
      adapter: "pi", provider: "anthropic",
      model: "claude-m",
      interval: "3h",
      intervalMs: 1,
    },
  });

/** A stub that performs `write` against the vault (capturing the rendered
 * prompt — runClaude passes it as stdin), then reports. */
const memoryModel = (
  write: () => void,
  captured?: { prompt?: string }
): PiLoader =>
  fakePi((prompt) => {
    if (captured) {
      captured.prompt = prompt;
    }
    write();
    return { result: "```report\ndid it\n```\n" };
  });

const run = (
  root: string,
  write: () => void,
  over: {
    captured?: { prompt?: string };
    fromScratch?: boolean;
    keepTree?: boolean;
  } = {}
): Promise<MemoryRunResult> =>
  runMemory({
    root,
    manifest: memManifest(root),
    force: true,
    loadPi: memoryModel(write, over.captured),
    ...(over.fromScratch ? { fromScratch: true } : {}),
    ...(over.keepTree ? { keepTree: true } : {}),
  });

/** A finished ledger message — the LEGACY "record changed" signal. */
function seedDone(root: string, finished: string, id = `q-${finished}`): void {
  mkdirSync(join(root, "queue", "done"), { recursive: true });
  writeFileSync(
    join(root, "queue", "done", `${id}.yaml`),
    `id: ${id}\nrefs:\n  - granola-not_x\nfrom: granola\nvia: granola\nenqueued: ${finished}\nfinished: ${finished}\noutcome: absorbed\n`
  );
}

const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

// ── due-ness: the delta stream moves to the assertion log ───────────────

describe("native due-ness — assertions trigger, raw arrivals do not", () => {
  test("an assertion past the cursor is work; a raw insertion alone is not", () => {
    const { root, asts, sources } = nativeVault(1);
    const stamp: MemoryStamp = {
      nextRunAt: "2026-08-18T09:00:00.000Z",
      assertionCursor: cursorAt(asts[0]!),
      insertionCursor: insCursorAt(sources[0]!),
    };
    writeMemoryStamp(root, stamp);
    expect(memoryWork(root)).toMatchObject({ record: 0 });

    // a raw arrival lands — inbox state, never a trigger: its assertions
    // make the pass due when extraction lands (Decision 2's corollary)
    const late = mkSource(5);
    appendSourceInsertionEvent(root, late);
    expect(hasMemoryWork(memoryWork(root))).toBe(false);
    const idle = memoryDue(root, { now: new Date("2026-08-18T12:00:00Z") });
    expect(idle.due).toBe(false);
    expect(idle.reason).toBe("nothing to fold in — no voice, no new assertions");

    // extraction lands: now the pass has something to fold
    appendAssertionEvent(root, mkAssertion(late, "asserted the late arrival.", at(30)));
    const w = memoryWork(root);
    expect(w.record).toBe(1);
    expect(describeMemoryWork(w)).toBe("1 new assertion(s)");
    expect(memoryDue(root, { now: new Date("2026-08-18T12:00:00Z") }).due).toBe(
      true
    );
  });

  // The queue's done ledger drove due-ness until #498 froze it, and the
  // fork that read it went on 2026-08-30. A vault still carrying done
  // messages must not be made due by them.
  test("the frozen done ledger drives nothing, on any vault", () => {
    const { root, asts } = nativeVault(1);
    writeMemoryStamp(root, {
      nextRunAt: "2026-08-18T09:00:00.000Z",
      assertionCursor: cursorAt(asts[0]!),
    });
    seedDone(root, "2026-08-18T10:30:00.000Z");
    expect(hasMemoryWork(memoryWork(root))).toBe(false);

    const legacy = gitVault({ prefix: "bb-memlegacy-", commit: false, git: false });
    seedDone(legacy, "2026-08-18T10:30:00.000Z");
    expect(hasMemoryWork(memoryWork(legacy))).toBe(false);
  });
});

// ── the run: cursors, rendered blocks, replay ───────────────────────────

describe("runMemory on a native vault", () => {
  test("backdated corrections and identity changes invalidate a successful checkpoint", () => {
    const { root, asts } = nativeVault(2);
    const stamp: MemoryStamp = {
      assertionCursor: cursorAt(asts[1]!), nextRunAt: at(3),
      checkpoint: readMemoryInputs(root).checkpoint,
    };
    writeMemoryStamp(root, stamp);
    expect(hasMemoryWork(memoryWork(root))).toBe(false);
    const corrected = supersedeEntity(root, {
      from: "Ada Lovelace", into: "Augusta Ada King", only: [asts[0]!.id], operator: "test",
    });
    const snapshot = readMemorySnapshot(root, stamp);
    expect(snapshot.astDelta.map((a) => a.id)).toEqual([corrected.items[0]!.copy]);
    expect(memoryDue(root, { now: new Date(at(4)) }).due).toBe(true);
    expect(snapshot.astDelta[0]!.created_at).toBe(asts[0]!.created_at);

    writeMemoryStamp(root, { ...stamp, checkpoint: snapshot.checkpoint });
    appendRevocationEvent(root, createRevocationEvent({
      assertion_id: asts[1]!.id, reason: "withdrawn", author: { kind: "user", id: "test" },
      created_at: at(5), produced_by: { procedure: "test", version: "1" },
    }));
    expect(memoryWork(root)).toMatchObject({ record: 0, recordChanged: true });
    writeMemoryStamp(root, { ...stamp, checkpoint: readMemoryInputs(root).checkpoint });
    appendEntityAliasEvent(root, createEntityAliasEvent({
      alias: "Countess Lovelace", entity: { id: assertionEntityId("Augusta Ada King"), label: "Augusta Ada King" },
      author: { kind: "user", id: "test" }, created_at: at(6), produced_by: { procedure: "test", version: "1" },
    }));
    expect(memoryWork(root)).toMatchObject({ record: 0, recordChanged: true });
  });

  test("a committed run recovers its checkpoint and schedule after .state is deleted", async () => {
    const { root, asts, sources } = nativeVault(1);
    const result = await run(root, () => writeFileSync(join(root, "memory", "MEMORY.md"),
      `${SEED_INDEX}\nAda tests sparse probes. [[${asts[0]!.id}]]\n`));
    expect(result.error).toBeUndefined();
    const stamp = readMemoryStamp(root);
    writeFileSync(join(root, ".state", "memory.json"), '{"checkpoint":{"assertions":null}}');
    expect(readMemoryStamp(root).checkpoint).toEqual(stamp.checkpoint);
    rmSync(join(root, ".state"), { recursive: true, force: true });
    const recovered = readMemoryStamp(root);
    expect(recovered.checkpoint).toEqual(stamp.checkpoint);
    expect(recovered.nextRunAt).toBe(stamp.nextRunAt);
    expect(hasMemoryWork(memoryWork(root))).toBe(false);
    // It arrived after the checkpoint, despite an older content timestamp.
    const late = mkAssertion(sources[0]!, "reported a late correction.", at(-100));
    appendAssertionEvent(root, late);
    expect(readMemorySnapshot(root, recovered).astDelta.map((a) => a.id)).toEqual([late.id]);
    expect(memoryDue(root, { now: new Date(Date.parse(stamp.nextRunAt!) + 1) }).due).toBe(true);
  });

  test("cursors advance to the snapshot's tail; the rerun is a no-op", async () => {
    const { root, asts, sources } = nativeVault(2);
    const captured: { prompt?: string } = {};
    const res = await run(
      root,
      () =>
        writeFileSync(
          join(root, "memory", "MEMORY.md"),
          `${SEED_INDEX}\nAda tests sparse probes. [[${asts[1]!.id}]]\n`
        ),
      { captured }
    );
    expect(res.error).toBeUndefined();
    expect(res.committed).toBe(true);

    const stamp = readMemoryStamp(root);
    expect(stamp.assertionCursor).toEqual(cursorAt(asts[1]!));
    expect(stamp.insertionCursor).toEqual(insCursorAt(sources[1]!));
    // the citation survived the canonicalizer into the committed tree — an
    // unresolvable ast link is left exactly as written
    expect(read(root, "memory/MEMORY.md")).toContain(`[[${asts[1]!.id}]]`);

    // replay stability: the same cursor names the same (empty) delta
    expect(memoryWork(root, stamp).record).toBe(0);
    expect(memoryWork(root, stamp).record).toBe(0);

    // rerun with no new events and no observations: the due gate declines
    // before the model is ever spawned
    const again = await runMemory({
      root,
      manifest: memManifest(root),
      loadPi: fakePi(() => {
        throw new Error("must not spawn");
      }),
    });
    expect(again.ran).toBe(false);
    expect(again.reason).toMatch(/nothing to fold in/);
  });

  test("the run context renders the two native blocks, not the done-message block", async () => {
    const { root, asts, sources } = nativeVault(2);
    const uncited = mkSource(5); // arrived, no assertion cites it
    appendSourceInsertionEvent(root, uncited);
    commitAll(root);
    writeMemoryStamp(root, {
      nextRunAt: "2026-08-18T09:00:00.000Z",
      assertionCursor: cursorAt(asts[0]!),
      insertionCursor: insCursorAt(sources[0]!),
    });
    const captured: { prompt?: string } = {};
    const res = await run(
      root,
      () =>
        writeFileSync(
          join(root, "memory", "MEMORY.md"),
          `${SEED_INDEX}\nAda tests sparse probes. [[${asts[1]!.id}]]\n`
        ),
      { captured }
    );
    expect(res.error).toBeUndefined();

    const p = captured.prompt!;
    expect(p).toContain("Mode: incremental (assertion cursor: " + asts[0]!.id + ")");
    expect(p).toContain("Every factual line must end with supporting assertion citations:");
    expect(p).toContain("## New assertions since cursor (1)");
    expect(p).toContain(`- ${asts[1]!.id} · direct · ${asts[1]!.created_at}`);
    expect(p).toContain(`text: ${asts[1]!.text}`); // canonical [[ent_…]] links intact
    expect(p).toContain("sources: Meeting 1");
    // insertion 1 is past the cursor but CITED, so only the raw arrival shows
    expect(p).toContain("## Arrived, not yet asserted (1)");
    expect(p).toContain(`- Meeting 5 (${insertionAt(uncited)})`);
    expect(p).not.toContain("## Record changes since last run");
  });

  test("a long backlog is clipped, newest kept, and says how many were elided", async () => {
    const { root, asts, sources } = nativeVault(1);
    const extra: AssertionEvent[] = [];
    for (let i = 0; i < MEMORY_MAX_ASSERTIONS_INLINE + 2; i++) {
      const a = mkAssertion(sources[0]!, `backlog fact ${i}.`, at(60 + i));
      appendAssertionEvent(root, a);
      extra.push(a);
    }
    writeMemoryStamp(root, {
      nextRunAt: "2026-08-18T09:00:00.000Z",
      assertionCursor: cursorAt(asts[0]!),
    });
    const captured: { prompt?: string } = {};
    const res = await run(
      root,
      () =>
        writeFileSync(
          join(root, "memory", "MEMORY.md"),
          `${SEED_INDEX}\nThe backlog is folded. [[${extra[extra.length - 1]!.id}]]\n`
        ),
      { captured }
    );
    expect(res.error).toBeUndefined();
    const p = captured.prompt!;
    expect(p).toContain(`## New assertions since cursor (${extra.length})`);
    expect(p).toContain("(2 earlier assertion(s) since the cursor elided");
    expect(p).not.toContain(`- ${extra[0]!.id}`); // oldest two elided
    expect(p).not.toContain(`- ${extra[1]!.id}`);
    expect(p).toContain(`- ${extra[extra.length - 1]!.id}`); // newest kept
  });

  test("a native first run elides the full-history dump, like the legacy first run", async () => {
    const { root, asts } = nativeVault(1, { tree: false });
    const captured: { prompt?: string } = {};
    const res = await run(
      root,
      () =>
        writeFileSync(
          join(root, "memory", "MEMORY.md"),
          `# Memory index\n\nAda tests sparse probes. [[${asts[0]!.id}]]\n`
        ),
      { captured }
    );
    expect(res.error).toBeUndefined();
    const p = captured.prompt!;
    expect(p).toContain("Mode: FIRST RUN");
    expect(p).toContain(
      '(first run — survey the record; 1 assertion event(s) exist under log/assertions/)'
    );
    expect(p).not.toContain(`- ${asts[0]!.id} ·`); // no inline dump
    expect(readMemoryStamp(root).assertionCursor).toEqual(cursorAt(asts[0]!));
  });

  // One rendered context, on every vault: the legacy fork (a "record
  // changes since last run" block off the frozen done ledger) went on
  // 2026-08-30 with the ledger reader behind it.
  test("a vault with no assertions yet renders the native context, at cursor zero", async () => {
    const root = gitVault({
      prefix: "bb-memlegacy-",
      dirs: ["memory", "prompts", "journal/memory", ".state"],
      files: {
        "prompts/memory.md": "MEMORY PASS TEMPLATE\n",
        "memory/MEMORY.md": SEED_INDEX,
      },
      identity: { name: "t", email: "t@t" },
      commit: "seed",
    });
    seedDone(root, "2026-08-18T10:30:00.000Z");
    writeMemoryStamp(root, {});
    const captured: { prompt?: string } = {};
    const res = await run(root, () => {}, { captured });
    expect(res.error).toBeUndefined();
    const p = captured.prompt!;
    expect(p).toContain("Mode: incremental (assertion cursor: none)");
    expect(p).toContain("Every factual line must end with supporting assertion citations:");
    expect(p).not.toContain("Record changes since last run");
    // and the stamp grows no cursors it has no events for
    const stamp = readMemoryStamp(root);
    expect(stamp.assertionCursor).toBeUndefined();
    expect(stamp.insertionCursor).toBeUndefined();
  });
});

// ── the citation gate ───────────────────────────────────────────────────

describe("citation validation — strict, like the budget", () => {
  test("an unknown assertion id reverts the run wholesale and journals it", async () => {
    const { root } = nativeVault(1);
    const res = await run(root, () => {
      writeFileSync(
        join(root, "memory", "MEMORY.md"),
        `${SEED_INDEX}\nInvented claim. [[ast_00000000000000000000dead]]\n`
      );
    });
    expect(res.error).toContain("unknown assertion citation(s): ast_00000000000000000000dead");
    // wholesale: the overwrite is back to HEAD
    expect(read(root, "memory/MEMORY.md")).toBe(SEED_INDEX);
    const journal = JSON.parse(read(root, `journal/memory/${res.run}.json`));
    expect(journal.error).toContain("unknown assertion citation");
  });

  test("a native run that folds new assertions but cites nothing is rejected", async () => {
    const { root } = nativeVault(1);
    const res = await run(root, () => {
      writeFileSync(join(root, "memory", "MEMORY.md"), `${SEED_INDEX}\nUncited new claim.\n`);
    });
    expect(res.error).toContain("uncited tree");
    expect(read(root, "memory/MEMORY.md")).toBe(SEED_INDEX);
  });

  test("a legacy run inventing [[ast_…]] citations is rejected too", async () => {
    const root = gitVault({
      prefix: "bb-memlegacy-",
      dirs: ["memory", "prompts", "journal/memory", "observations/pending", ".state"],
      files: {
        "prompts/memory.md": "MEMORY PASS TEMPLATE\n",
        "memory/MEMORY.md": SEED_INDEX,
      },
      identity: { name: "t", email: "t@t" },
      commit: "seed",
    });
    const res = await run(root, () => {
      writeFileSync(
        join(root, "memory", "MEMORY.md"),
        `${SEED_INDEX}\nPhantom. [[ast_00000000000000000000beef]]\n`
      );
    });
    expect(res.error).toContain("unknown assertion citation");
    expect(read(root, "memory/MEMORY.md")).toBe(SEED_INDEX);
  });
});

// ── the from-scratch operator procedure ─────────────────────────────────

describe("--from-scratch — the native regeneration posture", () => {
  test("backs the tree up out of the way, runs at cursor zero, re-advances", async () => {
    const { root, asts, sources } = nativeVault(1);
    writeMemoryStamp(root, {
      nextRunAt: "2027-01-01T00:00:00.000Z", // far off: fromScratch implies force
      assertionCursor: cursorAt(asts[0]!),
      insertionCursor: insCursorAt(sources[0]!),
    });
    let treeDuringRun: boolean | undefined;
    const captured: { prompt?: string } = {};
    const res = await run(
      root,
      () => {
        // the old tree must not be an input: it is GONE while the model runs
        treeDuringRun = existsSync(join(root, "memory", "MEMORY.md"));
        writeFileSync(
          join(root, "memory", "MEMORY.md"),
          `# Memory index\n\nRegenerated. [[${asts[0]!.id}]]\n`
        );
      },
      { captured, fromScratch: true }
    );
    expect(res.error).toBeUndefined();
    expect(treeDuringRun).toBe(false);
    expect(res.backup).toMatch(/^journal\/memory\/pre-native-backup-/);
    expect(read(root, `${res.backup}/MEMORY.md`)).toBe(SEED_INDEX); // isolated, intact
    expect(captured.prompt).toContain("Mode: FROM SCRATCH");
    expect(captured.prompt).toContain(
      '(from scratch — survey the record; 1 assertion event(s) exist under log/assertions/)'
    );
    const stamp = readMemoryStamp(root);
    expect(stamp.assertionCursor).toEqual(cursorAt(asts[0]!));
    expect(stamp.insertionCursor).toEqual(insCursorAt(sources[0]!));
  });

  test("--keep-tree explicitly selects the old tree as input: copy, not move", async () => {
    const { root, asts } = nativeVault(1);
    let treeDuringRun: boolean | undefined;
    const res = await run(
      root,
      () => {
        treeDuringRun = existsSync(join(root, "memory", "MEMORY.md"));
        writeFileSync(
          join(root, "memory", "MEMORY.md"),
          `${SEED_INDEX}\nRe-earned. [[${asts[0]!.id}]]\n`
        );
      },
      { fromScratch: true, keepTree: true }
    );
    expect(res.error).toBeUndefined();
    expect(treeDuringRun).toBe(true);
    expect(read(root, `${res.backup}/MEMORY.md`)).toBe(SEED_INDEX);
  });

  test("refuses on a legacy vault — there is no record to regenerate from", async () => {
    const root = gitVault({
      prefix: "bb-memlegacy-",
      dirs: ["memory", "prompts", ".state"],
      files: { "prompts/memory.md": "MEMORY PASS TEMPLATE\n", "memory/MEMORY.md": SEED_INDEX },
      identity: { name: "t", email: "t@t" },
      commit: "seed",
    });
    const res = await runMemory({
      root,
      manifest: memManifest(root),
      fromScratch: true,
      loadPi: fakePi(() => {
        throw new Error("must not spawn");
      }),
    });
    expect(res.ran).toBe(false);
    expect(res.error).toContain("no assertion events");
    expect(read(root, "memory/MEMORY.md")).toBe(SEED_INDEX); // nothing moved
    expect(readdirSync(join(root, "memory"))).toEqual(["MEMORY.md"]);
  });
});

/** #686: voice is the record's rarest and highest-ranked signal — 5
 * person-stamped arrivals among the canary's 1,247 — and bootstrap used to
 * elide it with "N exist in the log", sending the run off to grep raw JSON
 * for four items. Both measured from-scratch runs did exactly that. */
describe("voice on a from-scratch run", () => {
  test("is inlined, not replaced by a count", async () => {
    const { root, asts } = nativeVault(1);
    const voice = insertion({
      id: `ins_${"7".repeat(24)}`,
      source_id: "voice-1",
      author: { kind: "user", id: "nick" },
      title: "a directive",
      body: "All eyes on the Atlas run.",
      envelope: { id: "voice-1", kind: "directive", from: "nick", from_kind: "person" },
      received_at: at(90),
      content_sha256: "sha-voice",
    });
    appendSourceInsertionEvent(root, voice);
    commitAll(root, "voice");

    const captured: { prompt?: string } = {};
    await run(
      root,
      () =>
        writeFileSync(
          join(root, "memory", "MEMORY.md"),
          `${SEED_INDEX}\nAda ran the experiment. [[${asts[0]!.id}]]\n`
        ),
      { captured, fromScratch: true }
    );

    expect(captured.prompt).toContain("All eyes on the Atlas run.");
    expect(captured.prompt).not.toContain("voice arrival(s) exist in the log");
  });
});


describe("memory protocol upgrade notices", () => {
  test("old memory recommends a rebuild without scheduling one or upgrading on an incremental pass", async () => {
    const { root, asts, sources } = nativeVault(1);
    writeMemoryStamp(root, {
      nextRunAt: at(3), checkpoint: readMemoryInputs(root).checkpoint,
      assertionCursor: cursorAt(asts[0]!), insertionCursor: insCursorAt(sources[0]!),
    });
    expect(memoryNeedsRebuild(root)).toBe(true);
    const standing = memoryStanding(root);
    expect(standing.rebuildRecommended).toEqual({ current: 0, target: MEMORY_PROTOCOL_VERSION });
    expect(memoryLine(standing, Date.parse(at(4)))).toContain("bigbrain memory --from-scratch");
    expect(memoryDue(root, { now: new Date(at(4)) }).due).toBe(false);
    const result = await run(root, () => writeFileSync(join(root, "memory", "MEMORY.md"),
      `Updated. [[${asts[0]!.id}]]\n`));
    expect(result.error).toBeUndefined();
    expect(result.backup).toBeUndefined();
    expect(memoryNeedsRebuild(root)).toBe(true);
  });

  test("fresh rebuild clears the notice and journal recovery retains its version", async () => {
    const { root, asts } = nativeVault(1);
    const result = await run(root, () => writeFileSync(join(root, "memory", "MEMORY.md"),
      `Rebuilt. [[${asts[0]!.id}]]\n`), { fromScratch: true });
    expect(result.error).toBeUndefined();
    expect(readMemoryStamp(root).protocolVersion).toBe(MEMORY_PROTOCOL_VERSION);
    expect(memoryStanding(root).rebuildRecommended).toBeUndefined();
    expect(memoryNeedsRebuild(root)).toBe(false);
    rmSync(join(root, ".state"), { recursive: true, force: true });
    expect(readMemoryStamp(root).protocolVersion).toBe(MEMORY_PROTOCOL_VERSION);
    expect(memoryStanding(root).rebuildRecommended).toBeUndefined();
    expect(memoryNeedsRebuild(root)).toBe(false);
  });

  test("a failed rebuild restores even uncommitted memory and keeps the notice", async () => {
    const { root } = nativeVault(1);
    const before = "My uncommitted memory\n";
    writeFileSync(join(root, "memory", "MEMORY.md"), before);
    writeMemoryStamp(root, { nextRunAt: at(3), protocolVersion: 0 });
    const result = await run(root, () => {
      writeFileSync(join(root, "memory", "partial.md"), "Partial output");
      throw new Error("model failed during rebuild");
    }, { fromScratch: true });
    expect(result.error).toBeDefined();
    expect(read(root, "memory/MEMORY.md")).toBe(before);
    expect(existsSync(join(root, "memory/partial.md"))).toBe(false);
    expect(readMemoryStamp(root).protocolVersion).toBe(0);
    expect(memoryNeedsRebuild(root)).toBe(true);
  });

  test("retaining the old tree does not clear a notice; newer protocols are not downgraded", async () => {
    const { root, asts } = nativeVault(1);
    const write = () => writeFileSync(join(root, "memory", "MEMORY.md"), `Context. [[${asts[0]!.id}]]\n`);
    const kept = await run(root, write, { fromScratch: true, keepTree: true });
    expect(kept.error).toBeUndefined();
    expect(memoryNeedsRebuild(root)).toBe(true);
    writeMemoryStamp(root, { ...readMemoryStamp(root), protocolVersion: MEMORY_PROTOCOL_VERSION + 1 });
    expect(memoryNeedsRebuild(root)).toBe(false);
    const rebuilt = await run(root, write, { fromScratch: true });
    expect(rebuilt.error).toBeUndefined();
    expect(readMemoryStamp(root).protocolVersion).toBe(MEMORY_PROTOCOL_VERSION + 1);
  });
});

// ── edit_memory: passage trims share the run's rollback ─────────────────

describe("edit_memory — a failed run reverts passage edits too", () => {
  test("the model trims with edit_memory, then fails: the tree is restored", async () => {
    const { root } = nativeVault(1);
    const before = read(root, "memory/MEMORY.md");
    let during = "";
    const res = await runMemory({
      root, manifest: memManifest(root), force: true,
      loadPi: scriptedPi(async (_prompt, options) => {
        const edit = options.customTools!.find((t) => t.name === "edit_memory")!;
        await edit.execute("edit-1", { path: "memory/MEMORY.md", old_text: "standing context", new_text: "trimmed" }, new AbortController().signal);
        during = read(root, "memory/MEMORY.md");
        throw new Error("model failed after a trim");
      }),
    });
    expect(during).toContain("trimmed");
    expect(res.error).toBeDefined();
    expect(read(root, "memory/MEMORY.md")).toBe(before);
  });
});
