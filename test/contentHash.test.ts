import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecordedAssertions } from "../lib/assertionLog";
import { projectSourceInsertion, syncAssertionProjection } from "../lib/assertionProjection";
import { CONTENT_MIN, contentHash } from "../lib/contentHash";
import { exactCopyPairs, settleExactCopies } from "../lib/exactCopies";
import { appendSourceInsertionEvent, readSourceInsertionLog, sourceInsertion } from "../lib/insertionLog";
import { landReference } from "../lib/references";
import { vaultRecord } from "../lib/vaultReadModel";
import { mdVault } from "./support/vault";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const vault = () => { const root = mdVault(); roots.push(root); writeFileSync(join(root, "vault.yaml"), "integrations: {}\n"); syncAssertionProjection(root); return root; };
const BODY = "The orchard committee met in the barn and agreed the spring planting order. ".repeat(6);
const note = (title: string, received: string, body = BODY) => `---\ntitle: ${title}\nreceived: ${received}\n---\n${body}`;

test("a content hash is the body and the attachments alone; a slight body has none", () => {
  expect(contentHash(BODY)).toBe(contentHash(`\n${BODY}  `));
  expect(contentHash(BODY, [{ sha256: "a" }])).not.toBe(contentHash(BODY));
  expect(contentHash("Thanks!")).toBeUndefined();
  expect(contentHash("Thanks!", [{ sha256: "a" }])).toBeString();
  expect("x".repeat(CONTENT_MIN - 1).length).toBeLessThan(CONTENT_MIN);
});

test("the same content under another envelope lands nothing, and is answered with the source already there", () => {
  const root = vault();
  const first = landReference(root, note("Planting order", "2026-08-02T09:00:00.000Z"));
  const again = landReference(root, note("Planting order (resent)", "2026-08-03T09:00:00.000Z"));
  expect(first.deduped).toBe(false);
  expect(again).toMatchObject({ deduped: true, insertionId: first.insertionId });
  expect(readSourceInsertionLog(root)).toHaveLength(1);
  // a slight body is two arrivals, whoever sent it
  landReference(root, note("Ada", "2026-08-04T09:00:00.000Z", "Thanks!"));
  landReference(root, note("Bo", "2026-08-05T09:00:00.000Z", "Thanks!"));
  expect(readSourceInsertionLog(root)).toHaveLength(3);
});

test("copies already in a vault are not rewritten: the system says each is a copy of the first, once", () => {
  const root = vault();
  const a = sourceInsertion({ id: "orchard-1", title: "Planting order", received: "2026-08-02T09:00:00.000Z" }, BODY);
  const b = sourceInsertion({ id: "orchard-2", title: "Planting order, again", received: "2026-08-03T09:00:00.000Z" }, BODY);
  for (const s of [a, b]) { appendSourceInsertionEvent(root, s, { wake: false }); projectSourceInsertion(root, s); }
  expect(exactCopyPairs(root)).toEqual([[a.id, b.id]]);
  expect(settleExactCopies(root)).toBe(1);
  expect(exactCopyPairs(root)).toEqual([]);
  expect(settleExactCopies(root)).toBe(0);
  const said = readRecordedAssertions(root);
  expect(said).toHaveLength(1);
  expect(said[0]).toMatchObject({ kind: "identity", identity: { says: "copy" }, author: { kind: "system", id: "content-hash" } });
  expect(vaultRecord(root).copies.get(a.id)?.members.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
  expect(readSourceInsertionLog(root)).toHaveLength(2);
});
