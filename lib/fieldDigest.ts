/** fieldDigest.ts — what a vault reads as, in one hash
 * (docs/plans/2026-10-12-stages-and-views-refactor.md, Method: "Each PR is
 * proven").
 *
 * A refactor leaves a vault reading the same: the same live assertions,
 * entities resolved to the same names, the same sources settled, and the
 * same graph. Each is hashed on its own, so a change that moves the digest
 * says which reading moved. Layout is not in it: positions are a picture of
 * the graph, and the picture changes on purpose once (R7).
 *
 * It reads; the projection it reads may be brought up to date first, which
 * writes `.state/`. Run it on a scratch copy of a vault, never the live one.
 */
import { buildAssertionGraph } from "./assertionGraph";
import { sha256hex } from "./hash";
import { liveAssertionSql } from "./sourceSupersede";
import { vaultRecord, withSnapshot } from "./vaultReadModel";

export interface FieldDigest {
  digest: string;
  parts: { assertions: string; identity: string; settlement: string; graph: string };
  counts: { assertions: number; aliases: number; bindings: number; copies: number; cited: number; declined: number; nodes: number; edges: number };
}

const hashLines = (lines: Iterable<string>): string => sha256hex([...lines].sort().join("\n"));

export function fieldDigest(root: string): FieldDigest {
  const assertions = withSnapshot(root, ({ db }) => db.query(`SELECT a.id, a.event_json FROM assertions a
    WHERE a.revoked_by IS NULL AND ${liveAssertionSql("a")}`).all() as { id: string; event_json: string }[]);
  const record = vaultRecord(root);
  const aliases = [...record.aliases.canonical].map(([alias, entity]) => `alias\t${alias}\t${entity.id}\t${entity.label}`);
  const bindings = record.entitySources.filter((b) => b.bound).map((b) => `binding\t${b.entity.id}\t${b.insertion_id}`);
  const copies = [...new Set(record.copies.values())].map((c) => `copies\t${c.members.map((m) => m.id).join(",")}`);
  const graph = buildAssertionGraph(root, undefined, record);
  const nodes = graph.nodes.map((n) => JSON.stringify([n.id, n.group, n.title, n.degree, n.entity ?? false,
    [...(n.memberPaths ?? [])].sort(), [...(n.aliases ?? [])].sort()]));
  const edges = graph.edges.map((e) => JSON.stringify([e.source, e.target, e.weight ?? 1]));
  const parts = {
    assertions: hashLines(assertions.map((a) => `${a.id}\t${sha256hex(a.event_json)}`)),
    identity: hashLines([...aliases, ...bindings, ...copies]),
    settlement: hashLines([...[...record.cited].map((id) => `cited\t${id}`), ...[...record.declined].map((id) => `declined\t${id}`)]),
    graph: hashLines([...nodes.map((n) => `node\t${n}`), ...edges.map((e) => `edge\t${e}`)]),
  };
  return {
    digest: sha256hex(JSON.stringify(parts)),
    parts,
    counts: { assertions: assertions.length, aliases: aliases.length, bindings: bindings.length, copies: copies.length,
      cited: record.cited.size, declined: record.declined.size, nodes: nodes.length, edges: edges.length },
  };
}
