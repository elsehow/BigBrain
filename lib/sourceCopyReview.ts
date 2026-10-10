/** A person's word on whether two sources are one document (#206): the
 * declaration lib/sourceCopyLog.ts records and lib/sourceCopies.ts obeys
 * over every key and judgment, and the viewer's door to it. */

import { appendAndProjectSourceCopy } from "./assertionProjection";
import { operatorAuthor } from "./entityFolds";
import { json, readBody, type Route } from "./httpx";
import { insertionEventRel, type EventAuthor } from "./insertionLog";
import { commitSourceCopyEvents, createSourceCopyEvent, type SourceCopyEvent } from "./sourceCopyLog";
import { readSourceInsertionPath } from "./sourceFeed";
import { copyProposals, projectedSource, sourceCopiesRecord, sourceRecord } from "./vaultReadModel";
import type { CopyWhy } from "./sourceCopies";

/** A person's word on two sources, by path or id. "Same" is one event.
 * "Not the same" must hold against every link that would join them again:
 * a copy is cut from each other copy of its document, and two documents are
 * set apart pair by pair. */
export function declareCopies(root: string, input: { a: string; b: string; same: boolean },
  author: EventAuthor = operatorAuthor(), now: () => Date = () => new Date()): SourceCopyEvent[] {
  const id = (ref: string): string => {
    const found = readSourceInsertionPath(root, ref)?.id ?? projectedSource(root, ref)?.id;
    if (!found) throw new Error(`source copies: no source ${JSON.stringify(ref)}`);
    return found;
  };
  const [a, b] = [id(input.a), id(input.b)];
  if (a === b) throw new Error("source copies: a source is its own copy already");
  if (typeof input.same !== "boolean") throw new Error("source copies: say same, true or false");
  const groups = sourceCopiesRecord(root), members = (x: string): string[] => groups.get(x)?.members.map((m) => m.id) ?? [x];
  const together = groups.get(a) !== undefined && groups.get(a) === groups.get(b);
  const pairs: [string, string][] = input.same ? [[a, b]]
    : together ? members(a).filter((m) => m !== b).map((m) => [m, b])
    : members(a).flatMap((m) => members(b).map((n): [string, string] => [m, n]));
  const created_at = now().toISOString(), produced_by = { procedure: "source-copy-review", version: "1" };
  const events = pairs.map(([x, y]) => createSourceCopyEvent({ a: x, b: y, same: input.same, author, created_at, produced_by }));
  commitSourceCopyEvents(root, events.map((event) => appendAndProjectSourceCopy(root, event).path),
    `source copies: ${a} and ${b} ${input.same ? "are" : "are not"} one document`);
  return events;
}

/** What a source's note shows of its document: its other copies, each with
 * why when linked to it directly, and the documents it might be, one row
 * each (their best copy), the best-scored pair standing for the rest. */
export interface CopyReview {
  copies: { path: string; title: string; why?: CopyWhy }[];
  proposals: { path: string; title: string; score?: number }[];
}
export function copyReview(root: string, insertionId: string): CopyReview {
  const groups = sourceCopiesRecord(root), group = groups.get(insertionId), { sources } = sourceRecord(root);
  const at = (id: string) => { const s = sources.get(id); return s && { path: insertionEventRel(s), title: s.title }; };
  const copies = (group?.members ?? []).filter((m) => m.id !== insertionId).map((m) => {
    const why = group!.why(insertionId, m.id);
    return { path: insertionEventRel(m), title: m.title, ...(why ? { why } : {}) };
  });
  const mine = new Set(group?.members.map((m) => m.id) ?? [insertionId]);
  const rows = new Map<string, CopyReview["proposals"][number]>();
  for (const p of copyProposals(root, insertionId)) {
    const other = mine.has(p.a) ? p.b : p.a, lead = groups.get(other)?.members[0]!.id ?? other;
    const held = rows.get(lead), row = at(lead);
    if (!row || (held && (held.score ?? -1) >= (p.score ?? -1))) continue;
    rows.set(lead, { ...row, ...(p.score !== undefined ? { score: p.score } : {}) });
  }
  return { copies, proposals: [...rows.values()] };
}

/** The viewer's door: a person's word on a pair. */
export function sourceCopyRoutes(root: string, author: () => EventAuthor = operatorAuthor): Route[] {
  return [{
    method: "POST",
    path: "/api/source/copies",
    handler: ({ req, res }) => {
      void (async () => {
        try { json(res, 200, declareCopies(root, JSON.parse(await readBody(req)) as { a: string; b: string; same: boolean }, author())); }
        catch (e) { json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
      })();
    },
  }];
}
