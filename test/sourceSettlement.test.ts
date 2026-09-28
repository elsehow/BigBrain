import { sourceSummary } from "../lib/sourceSummary";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import { appendAssertionEvent, assertionEntityId, createAssertionEvent } from "../lib/assertionLog";
import { appendDeclineEvent, createDeclineEvent } from "../lib/declineLog";
import { appendRevocationEvent, createRevocationEvent } from "../lib/revocationLog";
import { projectSourceInsertion, syncAssertionProjection } from "../lib/assertionProjection";
import { buildAssertionGraph } from "../lib/assertionGraph";
import { pendingInsertionIds, recentFromSourceLog, recentSourcePage } from "../lib/sourceFeed";
import { insertion } from "./support/vault";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("settled arrivals never return as pending when the projection is absent or partially rebuilt", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-settlement-"));
  roots.push(root);
  const sources = ["Waiting", "Filed", "Declined", "Revoked", "Revoked and declined", "Live and revoked and declined"].map((title, i) => insertion({
    id: `ins_${String(i + 1).padStart(24, "0")}`, title,
    envelope: { type: "reference", kind: "web-clip", source: "api" },
  }));
  for (const source of sources) appendSourceInsertionEvent(root, source);
  // Simulate a reader of a rebuild that has reached only the source rows.
  for (const source of sources) projectSourceInsertion(root, source);
  const byId = new Map(sources.map(s => [s.id, s]));
  const author = { kind: "agent" as const, id: "gardener" };
  const produced_by = { procedure: "intake-agent", version: "v1" };
  const entity = { id: assertionEntityId("Example"), label: "Example" };
  for (const index of [1, 3, 4, 5]) {
    const event = createAssertionEvent({
      text: `[[${entity.id}|Example]] is discussed in source ${index}.`, entities: [entity],
      sources: [sources[index]!.id], author, produced_by, confidence: "direct",
      created_at: "2026-09-08T12:00:00Z",
    }, byId);
    appendAssertionEvent(root, event);
    if (index > 1) appendRevocationEvent(root, createRevocationEvent({
      assertion_id: event.id, reason: "withdrawn", author, produced_by,
      created_at: "2026-09-08T13:00:00Z",
    }));
  }
  appendAssertionEvent(root, createAssertionEvent({
    text: `[[${entity.id}|Example]] has another live claim.`, entities: [entity],
    sources: [sources[5]!.id], author, produced_by, confidence: "direct",
    created_at: "2026-09-08T13:30:00Z",
  }, byId));
  appendDeclineEvent(root, createDeclineEvent({
    insertion_ids: [sources[2]!.id, sources[4]!.id, sources[5]!.id], reason: "nothing to retain", author, produced_by,
    created_at: "2026-09-08T14:00:00Z",
  }, byId));
  const check = () => {
    const status = new Map(recentFromSourceLog(root).map(row => [row.title, row.status]));
    expect(sources.map(s => status.get(s.title))).toEqual(["pending", "filed", "declined", "filed", "declined", "filed"]);
    expect(recentSourcePage(root, 0, 10).recent).toEqual(recentFromSourceLog(root));
    expect([...pendingInsertionIds(root, sources.map(sourceSummary))]).toEqual([sources[0]!.id]);
    const graph = buildAssertionGraph(root);
    expect(graph.nodes.filter(n => n.pending).map(n => n.id)).toEqual([`source:${sources[0]!.id}`]);
    return graph.hash;
  };
  const hash = check();
  syncAssertionProjection(root);
  expect(check()).toBe(hash);
  rmSync(join(root, ".state"), { recursive: true, force: true });
  expect(check()).toBe(hash);
  for (const source of sources) projectSourceInsertion(root, source);
  expect(check()).toBe(hash);
});
