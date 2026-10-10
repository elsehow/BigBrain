/**
 * lib/sourceSupersede.ts — the read side of a source revision. A later
 * landing of the same source that names an earlier one (`supersedes`)
 * hides it from every reader: the feed, search, the graph, intake's due
 * set, the dossier's rows. The logs keep both; nothing is revoked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertionEntityId, createAssertionEvent, type AssertionEvent } from "../lib/assertionLog";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { assertionEntityPath, assertionEntityView } from "../lib/assertionEntityView";
import {
  appendAndProjectAssertion,
  assertionsWithRefsForEntity,
  listAssertions,
  sourceRefsForAssertions,
  searchAssertionProjection,
  searchAssertionSources,
  syncAssertionProjection,
} from "../lib/assertionProjection";
import type { SourceInsertion } from "../lib/insertionLog";
import { readMemorySnapshot } from "../lib/memoryContext";
import { recentFromSourceLog } from "../lib/sourceFeed";
import { assertionSuperseded, supersededInsertionIds, supersedesOf } from "../lib/sourceSupersede";
import { dueWork, nextWork, type IntakeInputs, type IntakeJob } from "../lib/work";
import { insertion, nativeVault } from "./support/vault";

const OLD = "ins_00000000000000000000aaaa";
const NEW = "ins_00000000000000000000bbbb";
const OTHER = "ins_00000000000000000000cccc";

/** One meeting landed twice: the flat transcript, then the relabeled one
 * naming it. `OTHER` is an unrelated source for contrast. */
const old = (): SourceInsertion => insertion({
  id: OLD, source_id: "granola-not_1", title: "Sync",
  body: "speaker: Ada said the Atlas experiment should test sparse probes.",
  envelope: { id: "granola-not_1", kind: "meeting" },
  received_at: "2026-08-10T10:00:00.000Z", occurred_at: "2026-08-10",
});
const successor = (over: Partial<SourceInsertion> = {}): SourceInsertion => insertion({
  id: NEW, source_id: "granola-not_1", title: "Sync",
  body: "Ada Lovelace: the Atlas experiment should test sparse probes.",
  envelope: { id: "granola-not_1", kind: "meeting", supersedes: OLD },
  received_at: "2026-09-03T10:00:00.000Z", occurred_at: "2026-08-10",
  content_sha256: "sha-new",
  ...over,
});
const other = (): SourceInsertion => insertion({
  id: OTHER, source_id: "src-other", title: "Unrelated",
  body: "Ben talked about Atlas probes too.",
  received_at: "2026-08-11T10:00:00.000Z", occurred_at: "2026-08-11",
});

const ada = { id: assertionEntityId("Ada Lovelace"), label: "Ada Lovelace" };
const author = { kind: "model", id: "test", invocation_id: "run-1" } as const;
const produced_by = { procedure: "test", version: "v1" } as const;
const assertion = (text: string, sources: SourceInsertion[], created_at: string): AssertionEvent =>
  createAssertionEvent(
    { text, entities: [ada], sources: sources.map((s) => s.id), author, confidence: "direct", created_at, produced_by },
    new Map(sources.map((s) => [s.id, s]))
  );

afterEach(() => {
  delete process.env["BIGBRAIN_ASSERTION_DB"];
});

describe("the rule", () => {
  test("supersedesOf reads only an insertion-shaped id", () => {
    expect(supersedesOf(successor())).toBe(OLD);
    expect(supersedesOf(old())).toBeUndefined();
    expect(supersedesOf(insertion({ envelope: { supersedes: "granola-not_1" } }))).toBeUndefined();
  });

  test("a later landing of the SAME source hides the one it names", () => {
    expect(supersededInsertionIds([old(), successor(), other()])).toEqual(new Set([OLD]));
  });

  test("naming a stranger hides nothing — the guard", () => {
    const impostor = successor({ source_id: "src-impostor", envelope: { id: "src-impostor", supersedes: OLD } });
    expect(supersededInsertionIds([old(), impostor])).toEqual(new Set());
  });

  test("naming an insertion the log does not hold hides nothing", () => {
    expect(supersededInsertionIds([successor()])).toEqual(new Set());
  });

  test("an assertion is hidden only when every held source it cites is superseded", () => {
    const held = (id: string) => id !== "ins_gone";
    const superseded = new Set([OLD]);
    expect(assertionSuperseded([OLD], superseded, held)).toBe(true);
    expect(assertionSuperseded([OLD, NEW], superseded, held)).toBe(false);
    expect(assertionSuperseded([OLD, "ins_gone"], superseded, held)).toBe(true);
    expect(assertionSuperseded(["ins_gone"], superseded, held)).toBe(false); // gone ≠ hidden
    expect(assertionSuperseded([], superseded, held)).toBe(false);
  });
});

describe("the readers", () => {
  test("the feed lists the successor once; the superseded landing is not a row", () => {
    const root = nativeVault({ prefix: "bb-supersede-feed-", insertions: [old(), successor(), other()] });
    const rows = recentFromSourceLog(root);
    expect(rows.map((r) => r.insertionId).sort()).toEqual([NEW, OTHER].sort());
  });

  test("intake never files the superseded landing — the successor is the due job", () => {
    const root = nativeVault({ prefix: "bb-supersede-work-", insertions: [old(), successor(), other()] });
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    const due = dueWork(root, { kinds: ["intake"] }) as IntakeJob[];
    expect(due.map((j) => j.insertion_id).sort()).toEqual([NEW, OTHER].sort());
  });

  test("the dossier and the graph drop a row grounded only on the superseded landing", () => {
    const o = old(), n = successor(), x = other();
    const root = nativeVault({ prefix: "bb-supersede-view-", insertions: [o, n, x] });
    const onlyOld = assertion(`[[${ada.id}|Ada]] said probes (old extraction).`, [o], "2026-08-10T11:00:00.000Z");
    const both = assertion(`[[${ada.id}|Ada]] said probes (cites both).`, [o, n], "2026-09-03T11:00:00.000Z");
    const onlyNew = assertion(`[[${ada.id}|Ada Lovelace]] said probes (relabeled).`, [n], "2026-09-03T11:01:00.000Z");
    const onOther = assertion(`[[${ada.id}|Ada]] came up with Ben.`, [x], "2026-08-11T11:00:00.000Z");
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    syncAssertionProjection(root);
    for (const a of [onlyOld, both, onlyNew, onOther]) appendAndProjectAssertion(root, a);

    const view = assertionEntityView(root, assertionEntityPath(ada.id))!;
    expect(view.assertions.map((a) => a.id).sort()).toEqual([both.id, onlyNew.id, onOther.id].sort());

    const graph = buildAssertionGraph(root);
    const sources = graph.nodes.filter((node) => node.group === "source").map((node) => node.id).sort();
    expect(sources).toEqual([`source:${NEW}`, `source:${OTHER}`].sort());
  });

  test("search and the listing door answer with the successor's rows only", () => {
    const o = old(), n = successor(), x = other();
    const root = nativeVault({ prefix: "bb-supersede-search-", insertions: [o, n, x] });
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    syncAssertionProjection(root);
    const onlyOld = assertion(`[[${ada.id}|Ada]] said sparse probes (old).`, [o], "2026-08-10T11:00:00.000Z");
    const onlyNew = assertion(`[[${ada.id}|Ada Lovelace]] said sparse probes (relabeled).`, [n], "2026-09-03T11:00:00.000Z");
    appendAndProjectAssertion(root, onlyOld);
    appendAndProjectAssertion(root, onlyNew);

    expect(searchAssertionSources(root, "probes").map((h) => h.insertion_id).sort()).toEqual([NEW, OTHER].sort());
    expect(searchAssertionProjection(root, "probes").map((h) => h.id)).toEqual([onlyNew.id]);
    expect(listAssertions(root).map((r) => r.id)).toEqual([onlyNew.id]);

    // the entity fan-out (searchCore's third path into sources) neither
    // lists the hidden row nor hands out an edge to the superseded landing
    const both = assertion(`[[${ada.id}|Ada]] said sparse probes (cites both).`, [o, n], "2026-09-03T11:01:00.000Z");
    appendAndProjectAssertion(root, both);
    const fanned = assertionsWithRefsForEntity(root, ada.id, 10);
    expect(fanned.map((r) => r.id).sort()).toEqual([both.id, onlyNew.id].sort());
    expect(fanned.flatMap((r) => r.refs.map((ref) => ref.insertion_id))).toEqual([NEW, NEW]);
    expect(sourceRefsForAssertions(root, [both.id]).get(both.id)!.map((ref) => ref.insertion_id)).toEqual([NEW]);
  });

  test("the successor's job names the prior landing it revises; a stranger's claim does not", () => {
    const o = old(), n = successor(), x = other();
    const impostor = successor({
      id: "ins_00000000000000000000dddd", source_id: "src-impostor", title: "Impostor",
      envelope: { id: "src-impostor", supersedes: OLD }, content_sha256: "sha-impostor",
    });
    const root = nativeVault({ prefix: "bb-supersede-next-", insertions: [o, n, x, impostor] });
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    syncAssertionProjection(root);
    const onlyOld = assertion(`[[${ada.id}|Ada]] said probes (old extraction).`, [o], "2026-08-10T11:00:00.000Z");
    appendAndProjectAssertion(root, onlyOld);

    const items = nextWork(root, { kinds: ["intake"] });
    const byId = new Map(items.map((item) => [item.job.kind === "intake" ? item.job.insertion_id : "", item]));
    const revision = byId.get(NEW)!.inputs as IntakeInputs;
    expect(revision.supersedes).toEqual({ insertion_id: OLD, source_id: "granola-not_1", title: "Sync" });
    // the prior landing's rows ride as the neighborhood — what to carry forward
    expect(revision.neighborhood.map((row) => row.id)).toEqual([onlyOld.id]);
    expect((byId.get(impostor.id)!.inputs as IntakeInputs).supersedes).toBeUndefined();
    expect((byId.get(OTHER)!.inputs as IntakeInputs).supersedes).toBeUndefined();
  });

  test("the memory pass does not see the superseded landing as unasserted", () => {
    const root = nativeVault({ prefix: "bb-supersede-memory-", insertions: [old(), successor(), other()] });
    const snapshot = readMemorySnapshot(root, {});
    expect(snapshot.unasserted.map((i) => i.id).sort()).toEqual([NEW, OTHER].sort());
  });

  test("replaying the logs into a fresh projection reaches the same view", () => {
    const root = nativeVault({ prefix: "bb-supersede-replay-", insertions: [old(), other(), successor()] });
    process.env["BIGBRAIN_ASSERTION_DB"] = join(root, ".state", "assertions.db");
    // successor projected LAST — the predicate looks across rows, so order
    // of arrival cannot matter
    syncAssertionProjection(root);
    const due = dueWork(root, { kinds: ["intake"] }) as IntakeJob[];
    expect(due.map((j) => j.insertion_id).sort()).toEqual([NEW, OTHER].sort());
  });
});
