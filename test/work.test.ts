/** work.test.ts — the queue is a view over the logs (#520).
 *
 * The invariants under test are the design doc's: a job exists because the
 * logs do not yet satisfy it; submit appends events and the job disappears
 * because the view recomputes; declines settle like assertions; deleting
 * `.state/` and replaying the logs reproduces the same due set; intake
 * drains in priority order; a transcript is intake for its owner's side
 * alone, three typed turns or more, last (2026-09-06, revisiting #528).
 */
import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { machineTools } from "../lib/run/machineTools";
import { insertionEventRel } from "../lib/insertionLog";
import { renderTurns, TRANSCRIPT_MARK, PILOT_TRANSCRIPT_MARK, renderUserSide, userSide } from "../lib/transcriptProjection";
import { assertionEntityId } from "../lib/assertionLog";
import { appendDeclineEvent, createDeclineEvent, readDeclineLog } from "../lib/declineLog";
import { appendSourceInsertionEvent, type SourceInsertion } from "../lib/insertionLog";
import {
  classifyIntake,
  WORK_BODY_INLINE_CHARS,
  dueIntakeCount,
  dueWork,
  nextWork,
  readIntake,
  submitWork,
  type IntakeInputs,
  type IntakeJob,
  type SubmitItem,
} from "../lib/work";
import { insertionSeq, nativeVault } from "./support/vault";

const AUTHOR = { kind: "model", id: "claude-test", invocation_id: "run-1" } as const;
const PRODUCED = { procedure: "test-gardener", version: "v1" } as const;

const insertion = insertionSeq();

/** A landed segment's body — renderTurns' shape under the item's header,
 * the owner and the assistant alternating. */
const session = (user: string[], assistant: string[]): string => {
  const turns = user.flatMap((text, i) => [
    { speaker: "user" as const, text },
    ...(assistant[i] ? [{ speaker: "assistant" as const, text: assistant[i]! }] : []),
  ]);
  return `# Claude Code — BigBrain\n\nSession \`abc\`, lines 1–9, in \`/tmp/p\`.\n\n${TRANSCRIPT_MARK}\n\n${renderTurns(turns)}\n`;
};

const vault = (...insertions: SourceInsertion[]): string =>
  nativeVault({ prefix: "bb-work-", insertions });

const assertionFor = (ins: SourceInsertion): SubmitItem => {
  const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
  return {
    submit: "assertion",
    text: `[[${ada.id}|Ada]] said sparse probes should be tested (${ins.source_id}).`,
    entities: [ada],
    sources: [ins.id],
    confidence: "direct",
  };
};

describe("dueWork — the queue as a view", () => {
  test("an uncited insertion is due; an assertion settles it; a decline settles it; replay agrees", () => {
    const a = insertion();
    const b = insertion();
    const root = vault(a, b);
    const due = () => dueWork(root, { kinds: ["intake"] }) as IntakeJob[];
    expect(due().map((j) => j.insertion_id).sort()).toEqual([a.id, b.id].sort());

    // an assertion settles a; b stays due
    const submitted = submitWork(root, [assertionFor(a)], { author: AUTHOR, produced_by: PRODUCED });
    expect(submitted.appended).toBe(1);
    expect(due().map((j) => j.insertion_id)).toEqual([b.id]);

    // a decline settles b — a durable no is an answer, not a retry loop
    const declined = submitWork(root, [
      { submit: "decline", insertion_ids: [b.id], reason: "duplicate of an earlier clip" },
    ], { author: AUTHOR, produced_by: PRODUCED });
    expect(declined.appended).toBe(1);
    expect(due()).toEqual([]);
    expect(dueIntakeCount(root)).toBe(0);

    // §1: delete every projection; replay the logs; the same (empty) due
    // set comes back — declines included
    rmSync(join(root, ".state"), { recursive: true, force: true });
    expect(due()).toEqual([]);
    expect(readDeclineLog(root, { strict: true })).toHaveLength(1);
  });

  test("intake drains in priority order: voice, meetings, reading, mail, other — oldest first within a class", () => {
    const mail = insertion({ envelope: { id: "m", kind: "email" } });
    const clipOld = insertion({ envelope: { id: "c1", kind: "web-clip" }, received_at: "2026-08-19T09:00:00.000Z" });
    const meeting = insertion({ envelope: { id: "g", kind: "meeting", source: "granola" } });
    const clipNew = insertion({ envelope: { id: "c2", kind: "web-clip" }, received_at: "2026-08-21T09:00:00.000Z" });
    const voice = insertion({ envelope: { id: "v", kind: "directive" } });
    const mystery = insertion({ envelope: { id: "x" } });
    const root = vault(mail, clipOld, meeting, clipNew, voice, mystery);
    const jobs = dueWork(root, { kinds: ["intake"] }) as IntakeJob[];
    expect(jobs.map((j) => j.insertion_id)).toEqual([
      voice.id, meeting.id, clipOld.id, clipNew.id, mail.id, mystery.id,
    ]);
    expect(jobs[0]!.class).toBe("voice");
    expect(jobs[jobs.length - 1]!.class).toBe("other");
  });

  test("a transcript is intake for its owner's side — three typed turns is the floor, and it ranks last", () => {
    const short = insertion({
      envelope: { id: "s", source: "agent-chat", from_kind: "agent" },
      body: session(["ship it"], ["Shipped."]),
    });
    const spoken = insertion({
      envelope: { id: "t", source: "agent-chat", from_kind: "agent" },
      body: session(
        ["not crazy about the edges", "keep it flat", "merge and cut a release"],
        ["Reverting.", "Done.", "Released 0.2.2."]
      ),
    });
    const clip = insertion({ envelope: { id: "c", kind: "web-clip" } });
    const drop = insertion({ envelope: { id: "d", kind: "idea", from_kind: "agent" } }); // a deliberate drop is intake (#528 re-cut)
    const mystery = insertion({ envelope: { id: "x" } });
    const root = vault(spoken, short, clip, drop, mystery);
    const ids = (dueWork(root, { kinds: ["intake"] }) as IntakeJob[]).map((j) => j.insertion_id);
    expect(ids.slice(0, 2).sort()).toEqual([clip.id, drop.id].sort());
    expect(ids.slice(2)).toEqual([mystery.id, spoken.id]);
    expect(dueIntakeCount(root)).toBe(4);
    // the gardener is served the owner's side alone; the landed body stays whole
    const item = nextWork(root, { kinds: ["intake"] }).find((i) => i.job.insertion_id === spoken.id)!;
    expect(item.job.kind === "intake" && item.job.class).toBe("agent-chat");
    const inputs = item.inputs as IntakeInputs;
    expect(inputs.insertion.body).toContain("--- THE OWNER'S SIDE (3 of 6 turns;");
    expect(inputs.insertion.body).toContain("user: keep it flat");
    expect(inputs.insertion.body).not.toContain("assistant:");
    expect(inputs.body_truncated).toBe(false);
    expect(inputs.body_length).toBe(inputs.insertion.body.length);
  });

  test("limit caps the intake pull", () => {
    const root = vault(insertion(), insertion(), insertion());
    expect(dueWork(root, { kinds: ["intake"], limit: 2 })).toHaveLength(2);
    expect(() => dueWork(root, { limit: 0 })).toThrow("positive integer");
  });

  test("the memory job appears only when the pass's own due-check says so", () => {
    const a = insertion();
    const root = vault(a);
    // no stamp: never auto-due (first run is deliberate)
    expect(dueWork(root, { kinds: ["memory"] })).toEqual([]);
    // an assertion lands, and the stamp says the sweep time has arrived
    submitWork(root, [assertionFor(a)], { author: AUTHOR, produced_by: PRODUCED });
    mkdirSync(join(root, ".state"), { recursive: true });
    writeFileSync(join(root, ".state", "memory.json"),
      JSON.stringify({ lastRunAt: "2026-08-20T00:00:00.000Z", nextRunAt: "2026-08-21T00:00:00.000Z" }));
    const jobs = dueWork(root, { kinds: ["memory"], now: new Date("2026-08-22T00:00:00.000Z") });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "memory", assertions: 1, observations: 0 });
  });
});

describe("nextWork — context packs, pure read", () => {
  test("packs the insertion and the record's neighborhood; calling twice returns the same items", () => {
    const a = insertion();
    const root = vault(a);
    // a prior assertion on the SAME source (different insertion) is neighborhood
    const b = insertion({ source_id: a.source_id, envelope: { id: a.source_id } });
    appendSourceInsertionEvent(root, b);
    submitWork(root, [assertionFor(b)], { author: AUTHOR, produced_by: PRODUCED });

    const items = nextWork(root, { kinds: ["intake"] });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    if (item.job.kind !== "intake") throw new Error("expected intake");
    expect(item.job.insertion_id).toBe(a.id);
    const inputs = item.inputs as IntakeInputs;
    expect(inputs.insertion.body).toContain("Ada said");
    expect(inputs.neighborhood).toHaveLength(1);
    expect(inputs.neighborhood[0]!.text).toContain("Ada");
    // pure read: no claim state — the second pull sees the same job
    expect(nextWork(root, { kinds: ["intake"] })[0]!.job).toEqual(item.job);
    expect(() => nextWork(root, { limit: 99 })).toThrow("1-8");
  });
});

describe("nextWork — inline-body cap (#514)", () => {
  test("a huge body is sliced with an honest length; a small one rides whole", () => {
    const big = insertion({ body: `sparse probes ${"x".repeat(WORK_BODY_INLINE_CHARS + 5_000)}` });
    const small = insertion();
    const root = vault(big, small);
    const items = nextWork(root, { kinds: ["intake"] });
    const bigItem = items.find((i) => i.job.kind === "intake" && i.job.insertion_id === big.id)!;
    const smallItem = items.find((i) => i.job.kind === "intake" && i.job.insertion_id === small.id)!;
    const bi = bigItem.inputs as { insertion: { body: string }; body_length: number; body_truncated: boolean };
    expect(bi.insertion.body.length).toBe(WORK_BODY_INLINE_CHARS);
    expect(bi.body_length).toBe(big.body.length);
    expect(bi.body_truncated).toBe(true);
    const si = smallItem.inputs as { insertion: { body: string }; body_truncated: boolean };
    expect(si.insertion.body).toBe(small.body);
    expect(si.body_truncated).toBe(false);
  });
});

describe("submitWork — per-item, idempotent, host-validated", () => {
  test("a malformed proposal rejects alone; the good item lands; a resubmit dedupes", () => {
    const a = insertion();
    const b = insertion();
    const root = vault(a, b);
    const bad: SubmitItem = {
      submit: "assertion", text: "[[ent_00000000000000000000|X]] unresolved claim here.",
      entities: [], sources: [b.id], confidence: "direct",
    };
    const first = submitWork(root, [assertionFor(a), bad], { author: AUTHOR, produced_by: PRODUCED });
    expect(first.appended).toBe(1);
    expect(first.rejected).toBe(1);
    expect(first.results[1]).toMatchObject({ ok: false });
    expect(first.results[1]!.error).toContain("undeclared entity link");
    // partial progress is durable: a is settled even though the batch had a failure
    expect((dueWork(root, { kinds: ["intake"] }) as IntakeJob[]).map((j) => j.insertion_id)).toEqual([b.id]);
    // idempotent: the same submission converges on the same event
    const again = submitWork(root, [assertionFor(a)], { author: AUTHOR, produced_by: PRODUCED });
    expect(again.deduped).toBe(1);
    expect(again.appended).toBe(0);
  });

  test("a decline citing an unknown insertion is rejected — evidence is validated like assertions", () => {
    const root = vault(insertion());
    const result = submitWork(root, [
      { submit: "decline", insertion_ids: ["ins_does_not_exist_anywhere"], reason: "nope" },
    ], { author: AUTHOR, produced_by: PRODUCED });
    expect(result.rejected).toBe(1);
    expect(result.results[0]!.error).toContain("unknown source insertion");
  });
});

describe("declineLog — immutable verdicts", () => {
  test("deterministic id, immutable collision, validation bounds", () => {
    const a = insertion();
    const root = vault(a);
    const sources = new Map([[a.id, a]]);
    const input = {
      insertion_ids: [a.id], reason: "already covered by the record",
      author: { kind: "model", id: "m", invocation_id: "i" } as const,
      created_at: "2026-08-22T00:00:00.000Z", produced_by: PRODUCED,
    };
    const event = createDeclineEvent(input, sources);
    // identity excludes created_at: a retry converges on the same id
    expect(createDeclineEvent({ ...input, created_at: "2026-08-23T00:00:00.000Z" }, sources).id).toBe(event.id);
    expect(appendDeclineEvent(root, event).deduped).toBe(false);
    expect(appendDeclineEvent(root, event).deduped).toBe(true);
    expect(() => appendDeclineEvent(root, { ...event, reason: "changed" })).toThrow("collision");
    expect(() => createDeclineEvent({ ...input, reason: "  " }, sources)).toThrow("reason");
    expect(() => createDeclineEvent({ ...input, insertion_ids: [] }, sources)).toThrow("at least one insertion");
  });
});

describe("classifyIntake", () => {
  test("maps envelope facts to priority classes", () => {
    expect(classifyIntake({ kind: "directive" })).toBe("voice");
    expect(classifyIntake({ kind: "meeting" })).toBe("meeting");
    expect(classifyIntake({ type: "transcript" })).toBe("meeting");
    expect(classifyIntake({ kind: "web-clip" })).toBe("reading");
    expect(classifyIntake({ kind: "paper" })).toBe("reading");
    expect(classifyIntake({ kind: "email" })).toBe("mail");
    expect(classifyIntake({})).toBe("other");
    expect(classifyIntake({ source: "agent-chat" })).toBe("agent-chat");
    expect(classifyIntake({ kind: "agent-chat" })).toBe("agent-chat");
    expect(classifyIntake({ kind: "idea", from_kind: "agent" })).toBe("reading"); // a deliberate drop is intake (#528 re-cut)
  });
});


describe("intake continuation", () => {
  for (const source of ["agent-chat", "pilot-chat"]) {
    test(`${source}: every page preserves the user-only view and author metadata`, async () => {
      const body = session(["first " + "x".repeat(25_000), "second " + "y".repeat(25_000), "last decision"],
        ["ASSISTANT_ONLY " + "z".repeat(30_000), "ASSISTANT_ONLY", "ASSISTANT_ONLY"])
        .replace(TRANSCRIPT_MARK, source === "pilot-chat" ? PILOT_TRANSCRIPT_MARK : TRANSCRIPT_MARK);
      const arrival = insertion({ body, envelope: { kind: source, from: "transcript-agent", from_kind: "agent" } });
      const root = vault(arrival);
      const initial = nextWork(root, { kinds: ["intake"] })[0]!.inputs as IntakeInputs;
      expect(initial.body_truncated).toBe(true);
      const tools = machineTools(root, "tend");
      const reader = tools.find(t => t.name === "read_intake")!;
      expect(reader).toBeDefined();
      let combined = initial.insertion.body;
      while (combined.length < initial.body_length) {
        const page = await reader.call({ insertion_id: arrival.id, start: combined.length, chars: 7000 }) as ReturnType<typeof readIntake>;
        expect(page.body_start).toBe(combined.length);
        expect(page.body_end).toBe(combined.length + page.insertion.body.length);
        expect(page.insertion.author).toEqual(arrival.author);
        expect(page.insertion.envelope).toEqual(arrival.envelope);
        combined += page.insertion.body;
      }
      expect(combined).toBe(renderUserSide(userSide(body)));
      expect(combined).not.toContain("ASSISTANT_ONLY");
      expect(combined).toContain("last decision");
      expect(() => tools.find(t => t.name === "read_note")!.call({ path: insertionEventRel(arrival), start: 20_000 }))
        .toThrow("Use read_intake");
      // Reading by other roles still returns the complete original evidence.
      const original = await machineTools(root, "memory").find(t => t.name === "read_note")!
        .call({ path: insertionEventRel(arrival), chars: 80_000 });
      expect(JSON.stringify(original)).toContain("ASSISTANT_ONLY");
    });
  }

  test("ordinary sources page without wrappers and remain readable after settlement", () => {
    const arrival = insertion({ body: "START " + "x".repeat(25_000) + " END", envelope: { kind: "email", from: "alice", from_kind: "person" } });
    const root = vault(arrival);
    const first = nextWork(root, { kinds: ["intake"] })[0]!.inputs as IntakeInputs;
    submitWork(root, [{ submit: "decline", insertion_ids: [arrival.id], reason: "test" }], { author: AUTHOR, produced_by: PRODUCED });
    const rest = readIntake(root, arrival.id, { start: first.insertion.body.length });
    expect(first.insertion.body + rest.insertion.body).toBe(arrival.body);
    expect(rest.insertion.envelope.from).toBe("alice");
    expect(rest.body_truncated).toBe(false);
    expect(readIntake(root, arrival.id, { start: 999999 }).insertion.body).toBe("");
    expect(() => readIntake(root, arrival.id, { chars: -1 })).toThrow();
    expect(() => readIntake(root, "missing")).toThrow("no insertion");
  });

  test("revisions expose and page all prior claims without duplicates or omissions", () => {
    const prior = insertion();
    const revised = insertion({ source_id: prior.source_id, envelope: { supersedes: prior.id } });
    const root = vault(prior, revised);
    const claims = Array.from({ length: 19 }, (_, i) => ({ ...assertionFor(prior), text: `[[${assertionEntityId("Ada Lovelace")}|Ada]] reported distinct result ${i}.` }));
    submitWork(root, claims, { author: AUTHOR, produced_by: PRODUCED });
    const initial = nextWork(root, { kinds: ["intake"] }).find(i => i.job.kind === "intake" && i.job.insertion_id === revised.id)!.inputs as IntakeInputs;
    expect(initial.supersedes?.insertion_id).toBe(prior.id);
    expect(initial.neighborhood).toHaveLength(8);
    expect(initial.neighborhood_truncated).toBe(true);
    let page = initial;
    const all = [...page.neighborhood];
    while (page.neighborhood_truncated) {
      const more = readIntake(root, revised.id, { neighborhood_start: page.neighborhood_next });
      all.push(...more.neighborhood);
      page = more;
    }
    expect(all).toHaveLength(19);
    expect(new Set(all.map(a => a.id)).size).toBe(19);
    expect(new Set(all.map(a => a.text))).toEqual(new Set(claims.map(a => a.text)));
    expect(page.neighborhood_next).toBeUndefined();
  });
});
