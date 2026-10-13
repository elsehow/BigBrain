/** exactCopies.ts — copies the content hash proves
 * (docs/plans/2026-10-11-field-of-assertions.md, step 2). The door lands
 * nothing for content the record already holds (lib/references.ts), but a
 * vault from before it holds the same note landed more than once. Those are
 * not rewritten: each later landing is said to be a copy of the first, by
 * the system, in an identity assertion proven by the hash. The copies chain
 * (lib/chains.ts) settles them before it asks any model about the rest.
 */
import { randomUUID } from "node:crypto";
import { commitAssertionEvents, createIdentityAssertion } from "./assertionLog";
import { appendAndProjectAssertion, projectedSourcesById } from "./assertionProjection";
import { copyPairKey } from "./sourceCopyLog";
import { withVaultSnapshot } from "./vaultReadModel";

/** Pairs of live landings with one content, the earliest first in each, that
 * nothing has yet said are or are not copies. */
export function exactCopyPairs(root: string): [string, string][] {
  return withVaultSnapshot(root, (db) => {
    const rows = db.query(`SELECT body_sha256 AS hash, insertion_id AS id FROM sources
      WHERE present = 1 AND body_sha256 IN (SELECT body_sha256 FROM sources WHERE present = 1 AND body_sha256 IS NOT NULL
        GROUP BY body_sha256 HAVING count(*) > 1)
      ORDER BY body_sha256, coalesce(received_at, occurred_at, ''), insertion_id`).all() as { hash: string; id: string }[];
    const said = new Set((db.query(`SELECT a, b FROM identities WHERE says IN ('copy', 'not-copy') AND retracted_by IS NULL`)
      .all() as { a: string; b: string }[]).map((r) => copyPairKey(r.a, r.b)));
    const pairs: [string, string][] = [];
    let first: { hash: string; id: string } | undefined;
    for (const row of rows) {
      if (first?.hash !== row.hash) { first = row; continue; }
      if (!said.has(copyPairKey(first.id, row.id))) pairs.push([first.id, row.id]);
    }
    return pairs;
  });
}

/** Say each one, as the system; the count said. */
export function settleExactCopies(root: string, now = new Date()): number {
  const pairs = exactCopyPairs(root);
  if (!pairs.length) return 0;
  const invocation = randomUUID(), paths: string[] = [];
  for (const [a, b] of pairs) {
    const event = createIdentityAssertion({ identity: { says: "copy" }, sources: [a, b],
      author: { kind: "system", id: "content-hash" }, created_at: now.toISOString(),
      produced_by: { procedure: "content-hash", version: "1", invocation_id: invocation } }, projectedSourcesById(root, [a, b]));
    paths.push(appendAndProjectAssertion(root, event).path);
  }
  commitAssertionEvents(root, paths, `source copies: ${paths.length} pair${paths.length === 1 ? "" : "s"} of one content, proven by its hash`);
  return paths.length;
}
