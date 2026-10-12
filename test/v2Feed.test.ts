import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertionEntityId, createAssertionEvent, type AssertionEvent } from "../lib/assertionLog";
import {
  appendAndProjectAssertion, appendAndProjectEntityAlias, appendAndProjectRevocation, projectJournal,
  rebuildAssertionProjection, recoverAssertionProjection, syncAssertionProjection,
} from "../lib/assertionProjection";
import { createEntityAliasEvent } from "../lib/entityAliasLog";
import type { FeedRecord } from "../lib/feedJournal";
import { appendSourceInsertionEvent, insertionEventRel, type SourceInsertion } from "../lib/insertionLog";
import { createRevocationEvent } from "../lib/revocationLog";
import { authorName, authorOf, newestFirst, pageSortedFeed, plainText, refreshSortedPages, type V2SortedRow } from "../lib/v2Feed";
import { readEntitiesCiting, readEntityFeed, readLensClaims, readSortedPage, readV2Feed } from "../lib/v2Read";
import { withVaultSnapshot } from "../lib/vaultReadModel";
import { insertion, mdVault } from "./support/vault";

const ent = (label: string) => ({ id: assertionEntityId(label), label });
const ada = ent("Ada Lovelace"), atlas = ent("Atlas"), orrery = ent("Orrery");
const day = (d: number, h = 12) => `2026-08-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;
const pi = { kind: "model", id: "pi", invocation_id: "mcp" } as const;
const codex = { kind: "model", id: "codex", invocation_id: "mcp" } as const;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const src = insertion({ id: `ins_${"a".repeat(24)}`, source_id: "minutes" });
const agenda = insertion({ id: `ins_${"b".repeat(24)}`, source_id: "agenda" });
function vault(...more: SourceInsertion[]): string {
  const root = mdVault(); roots.push(root);
  for (const s of [src, ...more]) appendSourceInsertionEvent(root, s);
  syncAssertionProjection(root);
  return root;
}
let n = 0;
type Over = { text?: string; supersedes?: string; project?: boolean; cites?: SourceInsertion[] };
function claim(root: string, author: AssertionEvent["author"], procedure: string, entities: Array<{ id: string; label: string }>, at: string,
  over: Over = {}): AssertionEvent {
  const event = createAssertionEvent({
    text: over.text ?? `${entities.map((e) => `[[${e.id}|${e.label}]]`).join(" and ")} came up, ${++n}.`, entities, sources: (over.cites ?? [src]).map((s) => s.id),
    author, confidence: "direct", created_at: at, produced_by: { procedure, version: "v1" }, ...(over.supersedes ? { supersedes: over.supersedes } : {}),
  }, new Map([src, agenda].map((s) => [s.id, s])));
  if (over.project !== false) appendAndProjectAssertion(root, event);
  return event;
}
const feed = (root: string) => withVaultSnapshot(root, (db) => readV2Feed(db));
const entityFeed = (root: string, id: string) => withVaultSnapshot(root, (db) => readEntityFeed(db, id));
function journal(root: string, dir: "tend" | "feed", id: string, record: object, project = true): void {
  const rel = `journal/${dir}/2026-08/${id}.json`;
  mkdirSync(join(root, "journal", dir, "2026-08"), { recursive: true });
  writeFileSync(join(root, rel), JSON.stringify({ invocation_id: id, ...record }));
  if (project) projectJournal(root, rel);
}
const tendRun = (root: string, id: string, model: string, started_at: string, completed_at: string, project = true) =>
  journal(root, "tend", id, { format: "bigbrain-tend-run/v1", insertion_ids: [], model, started_at, completed_at }, project);
const alias = (root: string, label: string, entity: { id: string; label: string }) => appendAndProjectEntityAlias(root, createEntityAliasEvent({
  alias: label, entity, author: { kind: "user", id: "robin" }, created_at: day(1), produced_by: { procedure: "fold", version: "v1" },
}));

describe("v2 feed", () => {
  test("authors are model and agent authors; the vault's own passes are one gardener", () => {
    const row = (author: AssertionEvent["author"], procedure: string) => ({ author, produced_by: { procedure, version: "v1" } });
    expect(authorOf(row({ kind: "model", id: "model-a" }, "intake-assertion-agent"))).toBe("gardener");
    expect(authorOf(row({ kind: "model", id: "model-b" }, "other-assertion-agent"))).toBe("gardener");
    expect(authorOf(row({ kind: "model", id: "claude-code" }, "bigbrain-mcp"))).toBe("claude-code");
    expect(authorOf(row({ kind: "agent", id: "tidy-up" }, "review"))).toBe("tidy-up");
    expect(authorOf(row({ kind: "user", id: "robin" }, "bootstrap"))).toBeNull();
    expect(authorOf(row({ kind: "system", id: "entity-supersede" }, "entity-supersede"))).toBeNull();
    expect(authorName("claude-code")).toBe("Claude Code");
    expect(authorName("tidy-up")).toBe("Tidy up");
  });

  test("authors carry only what the record says: live count and last write, most recent first", () => {
    const root = vault();
    claim(root, codex, "bigbrain-mcp", [atlas], day(2));
    claim(root, pi, "bigbrain-mcp", [ada], day(3));
    const gone = claim(root, codex, "bigbrain-mcp", [ada], day(5));
    claim(root, codex, "bigbrain-mcp", [orrery], day(4));
    claim(root, { kind: "user", id: "robin" }, "note", [ada], day(6));
    claim(root, { kind: "model", id: "model-a", invocation_id: "run-1" }, "intake-assertion-agent", [ada], day(1));
    appendAndProjectRevocation(root, createRevocationEvent({ assertion_id: gone.id, reason: "wrong", author: pi, created_at: day(7), produced_by: { procedure: "fix", version: "v1" } }));
    expect(feed(root).authors).toEqual([
      { id: "codex", name: "Codex", count: 2, lastAt: day(4) },
      { id: "pi", name: "Pi", count: 1, lastAt: day(3) },
      { id: "gardener", name: "Gardener", count: 1, lastAt: day(1) },
    ]);
  });

  test("a lens's entities are those named by live claims citing its notes, folded through aliases", () => {
    const root = vault(agenda);
    const short = ent("Ada");
    alias(root, "Ada", ada);
    claim(root, pi, "bigbrain-mcp", [short, atlas], day(1));
    claim(root, pi, "bigbrain-mcp", [ada], day(2));
    claim(root, pi, "bigbrain-mcp", [orrery], day(3), { cites: [agenda] });
    const citing = (ids: string[]) => withVaultSnapshot(root, (db) => readEntitiesCiting(db, ids)).toSorted();
    expect(citing(["minutes"])).toEqual([ada.id, atlas.id].toSorted());
    expect(citing([])).toEqual([]);
  });

  test("a lens's claims are the live ones whose every cited note it holds", () => {
    const root = vault(agenda);
    const minutes = claim(root, pi, "bigbrain-mcp", [ada], day(1));
    const both = claim(root, pi, "bigbrain-mcp", [atlas], day(2), { cites: [src, agenda] });
    const gone = claim(root, pi, "bigbrain-mcp", [orrery], day(3));
    appendAndProjectRevocation(root, createRevocationEvent({ assertion_id: gone.id, reason: "wrong", author: pi, created_at: day(4), produced_by: { procedure: "fix", version: "v1" } }));
    const claims = (members: string[]) => withVaultSnapshot(root, (db) => readLensClaims(db, members));
    expect(claims(["minutes"])).toEqual(new Set([minutes.id]));
    expect(claims(["minutes", "agenda"])).toEqual(new Set([minutes.id, both.id]));
    expect(claims([])).toEqual(new Set());
  });

  test("the feed is the latest live rows, oldest first, plain prose, entities folded through aliases", () => {
    const root = vault();
    const short = ent("Ada");
    alias(root, "Ada", ada);
    claim(root, pi, "bigbrain-mcp", [short, ada], day(1), { text: `Met [[${short.id}|Ada]] and [[${ada.id}|Ada Lovelace]] about the orrery.` });
    expect(feed(root).feed[0]).toMatchObject({ author: "pi", text: "Met Ada and Ada Lovelace about the orrery.", entities: [ada.id] });
    for (let i = 0; i < 70; i++) claim(root, codex, "bigbrain-mcp", [atlas], `2026-08-10T${String(i % 24).padStart(2, "0")}:${String(i).padStart(2, "0")}:00.000Z`);
    const rows = feed(root).feed;
    expect(rows).toHaveLength(60);
    expect(rows.map((r) => r.at)).toEqual(rows.map((r) => r.at).toSorted());
    expect(rows.every((r) => r.author === "codex")).toBe(true);
  });

  test("a row names its model only when the record does", () => {
    const root = vault();
    claim(root, { kind: "model", id: "model-a", invocation_id: "run-1" }, "intake-assertion-agent", [ada], day(1));
    claim(root, pi, "bigbrain-mcp", [ada], day(2));
    const [own, client] = feed(root).feed;
    expect(own).toMatchObject({ author: "gardener", by: "model-a", model: true });
    expect(client).toMatchObject({ author: "pi", by: "pi", model: false });
  });

  test("a gardener row is named by the model of the run it was written during, whichever lands first", () => {
    const root = vault();
    // a run's journal lands when it ends, after the rows it wrote...
    const inA = claim(root, pi, "bigbrain-mcp", [ada], "2026-08-02T10:30:00.000Z");
    const stranger = claim(root, codex, "bigbrain-mcp", [ada], "2026-08-02T10:31:00.000Z");
    const between = claim(root, pi, "bigbrain-mcp", [ada], day(3));
    tendRun(root, "run-a", "model-a", day(2, 10), day(2, 11));
    // ...and a row recovered after its run's journal finds it there
    tendRun(root, "run-b", "model-b", day(5, 10), day(5, 11));
    const inB = claim(root, { kind: "model", id: "claude", invocation_id: "mcp" }, "bigbrain-mcp", [ada], "2026-08-05T10:59:59.000Z");
    const named = () => Object.fromEntries(feed(root).feed.map((r) => [r.id, [r.author, r.by, r.model]]));
    const expected = {
      [inA.id]: ["gardener", "model-a", true], [stranger.id]: ["codex", "codex", false],
      [between.id]: ["pi", "pi", false], [inB.id]: ["gardener", "model-b", true],
    };
    expect(named()).toEqual(expected);
    expect(feed(root).authors.map((a) => [a.id, a.count])).toEqual([["gardener", 2], ["pi", 1], ["codex", 1]]);
    rebuildAssertionProjection(root);
    expect(named()).toEqual(expected);
  });

  test("a rewrite keeps the date its claim was first recorded, whichever of them is projected first", () => {
    const root = vault();
    // newest first, as a rebuild may read them: it reads a month by id, not by date
    const cleanup = { kind: "agent", id: "provenance-cleanup" } as const;
    const original = claim(root, codex, "bigbrain-mcp", [atlas], day(3), { project: false });
    const fixed = claim(root, cleanup, "cleanup", [atlas], day(21), { supersedes: original.id, project: false });
    const again = claim(root, cleanup, "cleanup", [atlas], day(25), { supersedes: fixed.id });
    appendAndProjectAssertion(root, fixed);
    appendAndProjectAssertion(root, original);
    const by = { author: pi, reason: "rewritten", produced_by: { procedure: "cleanup", version: "v1" } };
    appendAndProjectRevocation(root, createRevocationEvent({ ...by, assertion_id: original.id, superseded_by: fixed.id, created_at: day(21) }));
    appendAndProjectRevocation(root, createRevocationEvent({ ...by, assertion_id: fixed.id, superseded_by: again.id, created_at: day(25) }));
    const later = claim(root, pi, "bigbrain-mcp", [atlas], day(10));
    // the rewrite sorts at its original's date, and says when it was rewritten
    const dated = () => feed(root).feed.map((r) => [r.id, r.at, r.writtenAt]);
    expect(dated()).toEqual([[again.id, day(3), day(25)], [later.id, day(10), undefined]]);
    expect(entityFeed(root, atlas.id).map((r) => r.id)).toEqual([again.id, later.id]);
    rebuildAssertionProjection(root);
    expect(dated()).toEqual([[again.id, day(3), day(25)], [later.id, day(10), undefined]]);
  });

  test("an entity's own feed folds its aliases, from either name, latest six oldest first", () => {
    const root = vault();
    const short = ent("Ada");
    alias(root, "Ada", ada);
    const rows = [claim(root, pi, "bigbrain-mcp", [short], day(2))];
    claim(root, pi, "bigbrain-mcp", [orrery], day(3));
    for (let d = 4; d < 11; d++) rows.push(claim(root, pi, "bigbrain-mcp", [ada], day(d)));
    const latest = rows.slice(-6).map((r) => r.id);
    expect(entityFeed(root, ada.id).map((r) => r.id)).toEqual(latest);
    expect(entityFeed(root, short.id).map((r) => r.id)).toEqual(latest);
    expect(entityFeed(root, short.id)[0]!.entities).toEqual([ada.id]);
    expect(entityFeed(root, orrery.id).map((r) => r.at)).toEqual([day(3)]);
  });

  test("plain text reads wikilinks as their labels", () => {
    expect(plainText("Met [[ent_x|Ada]] about [[Atlas]].\n Again.")).toBe("Met Ada about Atlas. Again.");
  });
});

describe("sorted feed", () => {
  const gardener = { kind: "model", id: "model-a", invocation_id: "run-1" } as const;
  const entry = (source: string, section: string, assertions: string[], due: string | null = null) =>
    ({ source, section, headline: `About ${source}`, due, assertions });
  const call = (root: string, id: string, completed_at: string, entries: object[], over: Partial<FeedRecord> = {}, project = true) =>
    journal(root, "feed", id, { format: "bigbrain-feed-run/v1", assertions: [], entries, prompt_version: "v", started_at: completed_at, completed_at, ...over }, project);
  const page = (root: string, limit = 100, before?: string) => withVaultSnapshot(root, (db) => readSortedPage(root, db, limit, before));
  function fixture() {
    const root = vault();
    const [a, b, c, d] = [[ada], [atlas], [orrery], [ada, orrery]].map((e, i) => claim(root, gardener, "intake-assertion-agent", e, day(3 + i)));
    return { root, a: a!, b: b!, c: c!, d: d! };
  }

  test("newest first, the most pressing first within one arrival; joined to the live claims' entities and the source", () => {
    const { root, a, b, c, d } = fixture();
    call(root, "call-1", day(9), [entry("ins_old", "needs-you", [a.id])]);
    call(root, "call-2", day(10), [entry("ins_know", "know", [b.id]), entry("ins_agent", "agent", [c.id], "2026-08-20"), entry(src.id, "know", [a.id])]);
    call(root, "call-3", day(11), [entry("ins_new", "needs-you", ["ast_gone", a.id, d.id])]);
    const rows = page(root).rows;
    expect(rows.map((r) => [r.source, r.section, r.added])).toEqual([
      ["ins_new", "needs-you", day(11)], ["ins_agent", "agent", day(10)], [src.id, "know", day(10)], ["ins_know", "know", day(10)], ["ins_old", "needs-you", day(9)]]);
    expect(rows[0]!.entities).toEqual([ada.id, orrery.id]);
    expect(rows[1]!.due).toBe("2026-08-20");
    expect(rows[2]).toMatchObject({ title: src.title, path: insertionEventRel(src) });
    expect(rows[3]!.title).toBeUndefined();
  });

  test("a source keeps the item the first call placed it with, whatever order the journals are read in", () => {
    const { root, a, b } = fixture();
    call(root, "call-late", day(12), [entry("ins_x", "know", [b.id])]);
    call(root, "call-failed", day(8), [entry("ins_x", "needs-you", [a.id])], { error: { message: "offline" } });
    call(root, "call-early", day(9), [entry("ins_x", "agent", [a.id]), entry("ins_x", "know", [b.id]), entry("ins_y", "skip", [a.id])]);
    expect(page(root).rows.map((r) => [r.source, r.section, r.added, r.entities])).toEqual([["ins_x", "agent", day(9), [ada.id]]]);
  });

  test("an item whose claims were all revoked since is not shown", () => {
    const { root, a, b } = fixture();
    call(root, "call-1", day(9), [entry("ins_gone", "needs-you", [a.id]), entry("ins_kept", "know", [b.id])]);
    appendAndProjectRevocation(root, createRevocationEvent({ assertion_id: a.id, reason: "wrong", author: pi, created_at: day(12), produced_by: { procedure: "fix", version: "v1" } }));
    expect(page(root).rows.map((r) => r.source)).toEqual(["ins_kept"]);
  });

  test("pages walk the feed as pageSortedFeed does: each row once, a row's key the cut", () => {
    const { root, a } = fixture();
    const sections = ["know", "needs-you", "agent"];
    for (let i = 0; i < 25; i += 3)
      call(root, `call-${i}`, day(1 + i / 3), [0, 1, 2].filter((k) => i + k < 25).map((k) => entry(`ins_${String(i + k).padStart(3, "0")}`, sections[k]!, [a.id])));
    const all = page(root, 1000).rows;
    expect(all).toHaveLength(25);
    expect(all.map((r) => r.source)).toEqual(all.toSorted(newestFirst).map((r) => r.source));
    const walked: string[][] = [];
    let before: string | undefined;
    do {
      const next = page(root, 10, before);
      expect(next).toEqual(pageSortedFeed(all, 10, before));
      walked.push(next.rows.map((r) => r.source));
      before = next.next ?? undefined;
    } while (before);
    expect(walked.map((p) => p.length)).toEqual([10, 10, 5]);
  });

  test("a journal no process projected is found by the next one's census", () => {
    const { root, a } = fixture();
    call(root, "call-1", day(9), [entry("ins_one", "know", [a.id])], {}, false);
    tendRun(root, "run-a", "model-a", day(1), day(30), false);
    claim(root, pi, "bigbrain-mcp", [ada], day(20));
    expect(page(root).rows).toEqual([]);
    recoverAssertionProjection(root);
    expect(page(root).rows.map((r) => r.source)).toEqual(["ins_one"]);
    expect(feed(root).feed.at(-1)).toMatchObject({ author: "gardener", by: "model-a" });
  });
});

describe("sorted feed pages", () => {
  // three items to an arrival, so pages cut through one call's items
  const feed = (n: number, from = 0): V2SortedRow[] => Array.from({ length: n }, (_, i) => ({
    source: `ins_${String(from + i).padStart(3, "0")}`, section: (["know", "needs-you", "agent"] as const)[i % 3]!,
    headline: `Item ${from + i}`, due: null, added: day(1 + Math.floor((from + i) / 3)), entities: [],
  })).sort(newestFirst);
  const walk = (rows: V2SortedRow[], limit: number) => {
    const pages: string[][] = [];
    let before: string | undefined;
    do {
      const page = pageSortedFeed(rows, limit, before);
      pages.push(page.rows.map((r) => r.source));
      before = page.next ?? undefined;
    } while (before);
    return pages;
  };

  test("pages walk the whole feed newest first, each row once, and the last says there's no more", () => {
    const rows = feed(25);
    const pages = walk(rows, 10);
    expect(pages.map((p) => p.length)).toEqual([10, 10, 5]);
    expect(pages.flat()).toEqual(rows.map((r) => r.source));
    expect(pageSortedFeed(rows, 25).next).toBeNull();
    expect(pageSortedFeed([], 10)).toEqual({ rows: [], next: null });
  });

  test("what arrives between two pages doesn't shift the second; a row gone since still cuts in its place", () => {
    const rows = feed(20);
    const first = pageSortedFeed(rows, 8);
    const arrived = [...feed(4, 30), ...rows].sort(newestFirst);
    expect(pageSortedFeed(arrived, 8, first.next!).rows).toEqual(rows.slice(8, 16));
    const revoked = rows.filter((r) => r.source !== first.rows.at(-1)!.source);
    expect(pageSortedFeed(revoked, 8, first.next!).rows).toEqual(rows.slice(8, 16));
  });

  test("a refresh reads the loaded pages again: new rows on top, a revoked row gone, the rows pushed past it kept", () => {
    const rows = feed(30);
    const first = pageSortedFeed(rows, 10), second = pageSortedFeed(rows, 10, first.next!);
    const loaded = { rows: [...first.rows, ...second.rows], next: second.next };
    // three arrive and one loaded row is revoked; the refresh asks for as many as were loaded
    const now = [...feed(3, 40), ...rows.filter((r) => r.source !== rows[4]!.source)].sort(newestFirst);
    const merged = refreshSortedPages(loaded, pageSortedFeed(now, loaded.rows.length));
    expect(merged.rows).toEqual(now.slice(0, 22));
    expect(merged.next).toBe(second.next);
    expect(pageSortedFeed(now, 10, merged.next!).rows).toEqual(rows.slice(20, 30));
    // nothing pushed past: the fresh read's own next
    const fresh = pageSortedFeed(rows, 20);
    expect(refreshSortedPages(loaded, fresh)).toEqual(fresh);
  });
});
