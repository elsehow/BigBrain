/** voice.test.ts — user voice is arrivals (#521).
 *
 * The invariants under test are the plan's (work-as-a-view, "User voice is
 * arrivals"): a directive/request lands as an ordinary insertion through
 * the validated door and is DUE like any intake job; its `about` edge is
 * canonicalized and existence-checked; the gardener sees it as guidance
 * riding the job it is about, and settling is citation; an observation is
 * memory demand, never an intake job; the viewer reads voice insertions.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertionEntityId } from "../lib/assertionLog";
import type { SourceInsertion } from "../lib/insertionLog";
import { receive } from "../lib/intake";
import { landDirective } from "../lib/landItem";
import {
  describeMemoryWork,
  memoryWork,
  voiceDelta,
  writeMemoryStamp,
  type MemoryStamp,
} from "../lib/memory";
import {
  classifyIntake,
  dueIntakeCount,
  dueWork,
  nextWork,
  submitWork,
  type IntakeJob,
  type SubmitItem,
} from "../lib/work";
import { aboutIds, landVoice, VoiceError, voiceMessagesFor } from "../lib/voice";
import { insertionSeq, nativeVault } from "./support/vault";

type IntakePack = { job: IntakeJob; inputs: import("../lib/work").IntakeInputs };
const intakePack = (root: string, insertionId: string): IntakePack | undefined => {
  for (const p of nextWork(root, { kinds: ["intake"] }))
    if (p.job.kind === "intake" && p.job.insertion_id === insertionId) return p as IntakePack;
  return undefined;
};

const AUTHOR = { kind: "model", id: "claude-test", invocation_id: "run-v" } as const;
const PRODUCED = { procedure: "test-gardener", version: "v1" } as const;

const insertion = insertionSeq((n) => ({ body: `Body of item ${n}: Ada described the Atlas run.` }));

const vault = (...insertions: SourceInsertion[]): string =>
  nativeVault({ prefix: "bb-voice-", insertions });

const assertionCiting = (ids: string[], text = "claim"): SubmitItem => {
  const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
  return {
    submit: "assertion",
    text: `[[${ada.id}|Ada]] — ${text}.`,
    entities: [ada],
    sources: ids,
    confidence: "direct",
  };
};

const NICK = { from: "nick@example.com", via: "web-edge", from_kind: "person" as const };

describe("landVoice — the one voice landing", () => {
  test("a directive lands as an insertion: kind, canonicalized about, identity, title", () => {
    const clip = insertion();
    const root = vault(clip);
    // an insertion event id canonicalizes to its source id
    const landed = landVoice(
      root,
      { kind: "directive", text: "File this under Atlas.\nSecond line.", about: [clip.id] },
      NICK,
      { idPrefix: "web" }
    );
    expect(landed.id.startsWith("ins_")).toBe(true);
    expect(landed.title).toBe("File this under Atlas.");
    const due = dueWork(root, { kinds: ["intake"] }) as IntakeJob[];
    const voiceJob = due.find((j) => j.insertion_id === landed.id);
    expect(voiceJob?.class).toBe("voice");
    // voice ranks first — before the clip it is about
    expect(due[0]!.insertion_id).toBe(landed.id);
    // the envelope carries the canonicalized SOURCE id and the stamp
    const voiceItem = intakePack(root, landed.id);
    if (!voiceItem) throw new Error("voice item missing");
    const env = voiceItem.inputs.insertion.envelope as Record<string, unknown>;
    expect(aboutIds(env)).toEqual([clip.source_id]);
    expect(env["from"]).toBe("nick@example.com");
    expect(env["from_kind"]).toBe("person");
    expect(String(env["id"])).toMatch(/^web-/);
    // the voice job's pack names what it is about
    expect(voiceItem.inputs.about).toEqual([
      { source_id: clip.source_id, insertion_id: clip.id, title: clip.title },
    ]);
  });

  test("the clip's job carries the unsettled directive as guidance; citation settles both", () => {
    const clip = insertion();
    const root = vault(clip);
    const note = landDirective(
      root,
      { refs: [clip.source_id], guidance: "This is the Atlas kickoff — link it to the project." },
      NICK
    );
    const before = intakePack(root, clip.id);
    if (!before) throw new Error("clip pack missing");
    expect(before.inputs.voice?.map((v) => v.insertion_id)).toEqual([note.id]);
    expect(before.inputs.voice?.[0]?.from_kind).toBe("person");
    expect(before.inputs.voice?.[0]?.text).toContain("Atlas kickoff");

    // one assertion citing clip AND note settles both jobs…
    const r = submitWork(root, [assertionCiting([clip.id, note.id], "Atlas kickoff filed")], {
      author: AUTHOR,
      produced_by: PRODUCED,
    });
    expect(r.appended).toBe(1);
    expect(dueIntakeCount(root)).toBe(0);
    // …and the guidance stops riding (nothing due, but assert directly too)
    expect(intakePack(root, clip.id)).toBeUndefined();
  });

  test("validation refuses what the contract refuses", () => {
    const clip = insertion();
    const root = vault(clip);
    const code = (fn: () => unknown): string => {
      try {
        fn();
      } catch (e) {
        if (e instanceof VoiceError) return e.code;
      }
      return "no-error";
    };
    expect(code(() => landVoice(root, { kind: "memo" as never }, NICK))).toBe("bad-kind");
    expect(code(() => landVoice(root, { kind: "directive" }, NICK))).toBe("empty-message");
    expect(code(() => landVoice(root, { kind: "directive", text: "x", about: ["nope"] }, NICK))).toBe(
      "bad-about"
    );
    expect(
      code(() => landVoice(root, { kind: "directive", text: "x", query: "q" }, NICK))
    ).toBe("bad-query");
    expect(code(() => landVoice(root, { kind: "observation" }, NICK))).toBe("empty-message");
    expect(
      code(() =>
        landVoice(root, { kind: "observation", text: "why" }, { from: " ", via: "cli" })
      )
    ).toBe("bad-principal");
    expect(
      code(() =>
        landVoice(
          root,
          { kind: "observation", text: "why", urgency: "later" as never },
          NICK
        )
      )
    ).toBe("bad-urgency");
    // nothing landed along the way
    expect(dueWork(root, { kinds: ["intake"] })).toHaveLength(1); // the clip alone
  });
});

describe("observations are memory demand, never intake (#521)", () => {
  test("classifyIntake: voice outranks agent-chat; observation is excluded", () => {
    expect(classifyIntake({ kind: "directive", from_kind: "agent" })).toBe("voice");
    expect(classifyIntake({ kind: "request", from_kind: "person" })).toBe("voice");
    expect(classifyIntake({ kind: "observation", from_kind: "person" })).toBe("observation");
    expect(classifyIntake({ source: "agent-chat" })).toBe("agent-chat");
    expect(classifyIntake({ kind: "meeting" })).toBe("meeting");
  });

  test("an observation never enters the due set, and the memory view consumes it by cursor", () => {
    const clip = insertion();
    const root = vault(clip);
    // make the vault assertion-native (memoryWork's native gate)
    submitWork(root, [assertionCiting([clip.id], "seeded")], { author: AUTHOR, produced_by: PRODUCED });

    const landed = landVoice(
      root,
      { kind: "observation", text: "asked about Atlas twice", query: "atlas", urgency: "now" },
      { from: "helper", via: "cli:search", from_kind: "agent" }
    );
    expect(dueWork(root, { kinds: ["intake"] })).toHaveLength(0);
    expect(dueIntakeCount(root)).toBe(0);

    const stamp: MemoryStamp = {};
    const work = memoryWork(root, stamp);
    expect(work.voice.map((v) => v.id)).toEqual([landed.id]);
    expect(describeMemoryWork(work)).toContain("1 voice note(s)");

    // the cursor consumes it, exactly like every other log read
    const tail = voiceDelta(root, {}).at(-1)!;
    writeMemoryStamp(root, {
      insertionCursor: { at: tail.received_at ?? "", id: tail.id },
    });
    expect(memoryWork(root).voice).toHaveLength(0);
  });
});

describe("kind: request lands natively (#521 — the divert retires)", () => {
  test("receive() lands a request as an insertion: no queue message, no desk copy", () => {
    const root = vault();
    const content = `---\nid: req-001\nkind: request\ntitle: Merge the two Atlas entities\n---\n\nPlease merge them.\n`;
    const receipt = receive({ root, dest: "inbox", content, poke: false });
    expect(receipt.id).toBe("req-001");
    expect(receipt.path).toMatch(/^log\/insertions\//);
    const due = dueWork(root, { kinds: ["intake"] }) as IntakeJob[];
    expect(due).toHaveLength(1);
    expect(due[0]!.class).toBe("voice");
    // no queue side: nothing under queue/, nothing under inbox/
    const { existsSync, readdirSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(join(root, "queue", "pending"))).toBe(false);
    const inbox = existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")) : [];
    expect(inbox).toHaveLength(0);
  });
});

describe("voiceMessagesFor — the viewer's directive read (#521)", () => {
  test("a directive about a note reads back pending, then done with its outcome", () => {
    const clip = insertion();
    const root = vault(clip);
    const note = landDirective(root, { refs: [clip.source_id], guidance: "keep this" }, NICK);
    const rows = voiceMessagesFor(root, [clip.source_id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "pending",
      id: note.id,
      refs: [clip.source_id],
      guidance: "keep this",
      from: "nick@example.com",
      from_kind: "person",
      kind: "directive",
    });

    submitWork(
      root,
      [{ submit: "decline", insertion_ids: [note.id], reason: "nothing to add" }],
      { author: AUTHOR, produced_by: PRODUCED }
    );
    const after = voiceMessagesFor(root, [clip.source_id]);
    expect(after[0]).toMatchObject({ state: "done", outcome: "declined" });
    // keys it is not about stay silent
    expect(voiceMessagesFor(root, ["src-other"])).toHaveLength(0);
  });
});
