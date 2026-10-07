/** Graph projection of assertion relationships and explicit internal Markdown
 * links. The optional observer supplies grounding to the note briefing without
 * shipping assertion text in the graph payload. */
import { vaultRecord, type VaultRecord } from "./vaultReadModel";

import { createHash } from "node:crypto";
import { assertionSourceReferences, type AssertionEvent } from "./assertionLog";
import type { Graph, GraphEdge, GraphNode } from "./graph";
import { insertionEventRel, sourceMoment, type SourceMetadata } from "./insertionLog";
import { assertionSuperseded } from "./sourceSupersede";
import { assertionEntityPath } from "./assertionEntityView";
import { insertionFiler, pendingInsertionIds } from "./sourceFeed";
import { resolveAssertionIdIn } from "./revocationLog";
import { userIdentityDeclarationsFromEvents } from "./userIdentityPolicy";
import { resolveDocumentLinks, noteLinkResolver, type ConnectionEvidence, type ObserveConnection } from "./markdownGraph";
import { isUserNode } from "./userNote";

export function buildAssertionGraph(root: string, observe?: ObserveConnection, record: VaultRecord = vaultRecord(root, true)): Graph {
  const { revoked, rows: assertions, superseded, threadByInsertion: threads, sources: sourceByInsertion } = record;
  const events = [...sourceByInsertion.values()];
  // The arrivals the gardener has not reached yet draw too — as points
  // waiting for their threads (Nick, 2026-09-06: a drop "should appear in
  // the graph as an isolated node … a spinner, showing it's being
  // processed", and once filed "we follow it, see where it links"). The
  // verdict is the feed's own, so the row's mark and the node agree.
  const pending = pendingInsertionIds(root, events, record);
  const documents = record.documents.map(d => ({ ...d }));
  if (!assertions.length && !events.length && !documents.length) return { nodes: [], edges: [], hash: "assertions-empty", projection: "assertions" };

  const sourceKey = (id: string): string => threads.get(id)?.id ?? `source:${id}`;
  const threadNodes = new Map<string, GraphNode>();
  const groupedNode = (source: SourceMetadata, degree: number): GraphNode => {
    const thread = threads.get(source.id);
    if (!thread) return sourceNode(source, degree);
    let node = threadNodes.get(thread.id);
    if (!node) {
      node = { ...sourceNode(thread.members[0]!, 0), id: thread.id, path: thread.path,
        title: thread.title, memberPaths: [...thread.members.map(insertionEventRel), ...thread.aliases] };
      threadNodes.set(thread.id, node);
    }
    return { ...node, degree };
  };
  // Every linked entity resolves through the alias log (lib/entityAliasLog.ts)
  // before it becomes a node: "Evan" and "Evan Keller" draw as one.
  const resolve = (entity: AssertionEvent["entities"][number]) => record.aliases.canonical.get(entity.id) ?? entity;
  const resolvedEntities = (assertion: AssertionEvent) =>
    [...new Map(assertion.entities.map((entity) => {
      const canonical = resolve(entity);
      return [canonical.id, canonical] as const;
    })).values()];
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdges = new Map<string, GraphEdge>();

  // One edge per pair; a pair put together by a second assertion gains
  // WEIGHT instead of a second edge (GraphEdge.weight — absent means once).
  // The count is the only thing the projection knows beyond "these two
  // co-occur", and the viewer draws it as a brighter thread.
  const addEdge = (left: string, right: string, evidence?: ConnectionEvidence): void => {
    if (left === right) return;
    if (evidence) observe?.(left, right, evidence);
    const [source, target] = left < right ? [left, right] as const : [right, left] as const;
    const key = `${source}\u0000${target}`;
    const seen = seenEdges.get(key);
    if (seen) {
      seen.weight = (seen.weight ?? 1) + 1;
      return;
    }
    const edge: GraphEdge = { source, target };
    seenEdges.set(key, edge);
    edges.push(edge);
    nodes.get(source)!.degree++;
    nodes.get(target)!.degree++;
  };

  for (const assertion of assertions) {
    if (assertionSuperseded(
      assertionSourceReferences(assertion).map((ref) => ref.insertion_id), superseded, (i) => sourceByInsertion.has(i)
    )) continue;
    // Every cited arrival remains an openable source in the graph.
    const refs = assertionSourceReferences(assertion)
      .filter((ref) => sourceByInsertion.has(ref.insertion_id) && !superseded.has(ref.insertion_id));
    const sourceIds = [...new Set(refs.map((ref) => sourceKey(ref.insertion_id)))];
    const entities = resolvedEntities(assertion);
    const entityIds = entities.map((entity) => entity.id);

    for (const ref of refs) {
      const source = sourceByInsertion.get(ref.insertion_id)!;
      const key = sourceKey(source.id);
      nodes.set(key, groupedNode(source, nodes.get(key)?.degree ?? 0));
    }
    for (const entity of entities) {
      const prior = nodes.get(entity.id);
      if (prior && prior.title.toLocaleLowerCase() !== entity.label.toLocaleLowerCase())
        throw new Error(`assertion-graph: entity label collision: ${entity.id}`);
      const aliases = record.aliases.labels.get(entity.id)?.filter((a) => a.toLocaleLowerCase() !== entity.label.toLocaleLowerCase());
      if (!prior) nodes.set(entity.id, {
        id: entity.id,
        title: entity.label,
        group: "entity",
        degree: 0,
        entity: true,
        path: assertionEntityPath(entity.id),
        ...(aliases?.length ? { aliases } : {}),
      });
    }

    // Every linked entity is grounded in every source cited by the assertion.
    for (const entityId of entityIds)
      for (const sourceId of sourceIds) addEdge(entityId, sourceId, { assertion: assertion.id, text: assertion.text });
    // Multiple entities linked in one proposition form a relationship in the
    // visual projection. Its meaning remains the assertion's prose, not an
    // inferred predicate on this edge.
    for (let left = 0; left < entityIds.length; left++)
      for (let right = left + 1; right < entityIds.length; right++)
        addEdge(entityIds[left]!, entityIds[right]!, { assertion: assertion.id, text: assertion.text });
  }

  // Uncited arrivals still belong to the graph. A decline settles their
  // filing state without removing the source or its provider identity.
  for (const source of events) {
    if (superseded.has(source.id)) continue;
    const key = sourceKey(source.id);
    if (nodes.has(key)) continue;
    nodes.set(key, { ...groupedNode(source, 0), ...(pending.has(source.id) ? { pending: true } : {}) });
  }

  // Explicit Markdown links and cited memory evidence use the same edges as
  // the reading aid. Source import paths and folded entity ids are aliases,
  // so a link never creates a second node for an existing record.
  const aliases: Array<[string, string]> = [];
  for (const source of events) {
    if (superseded.has(source.id)) continue;
    if (source.imported_path) aliases.push([source.imported_path, sourceKey(source.id)]);
  }
  for (const assertion of assertions) for (const entity of assertion.entities) {
    const id = resolve(entity).id;
    aliases.push([entity.id, id], [assertionEntityPath(entity.id), id]);
  }
  const imported = new Map(aliases);
  for (const doc of documents) if (doc.path.startsWith("entities/")) {
    const matches = [...nodes.values()].filter(n => n.entity && n.title.toLowerCase() === doc.title.toLowerCase());
    if (matches.length === 1) { imported.set(doc.path, matches[0]!.id); aliases.push([doc.path, matches[0]!.id]); }
  }
  for (const doc of documents) {
    doc.id = imported.get(doc.path) ?? doc.id;
    const existing = nodes.get(doc.id);
    if (existing && existing.path !== doc.path)
      existing.memberPaths = [...new Set([...(existing.memberPaths ?? []), doc.path])].sort();
    if (!nodes.has(doc.id)) nodes.set(doc.id, { id: doc.id, path: doc.path, title: doc.title,
      group: doc.path.startsWith("memory/") ? "memory" : "note", degree: 0 });
  }
  const linkResolver = noteLinkResolver(nodes.values(), aliases);
  const byAssertion = new Map(assertions.map(a => [a.id, a]));
  const sourceIds = new Set(events.map(s => sourceKey(s.id)));
  const memoryTargets = new Map<string, Set<string>>();
  const linkDocuments = [...documents.filter(d => !sourceIds.has(d.id)).map(d => ({ ...d, parsed: record.documentLinks.get(`markdown:${d.path}`)! })), ...events.filter(s => !superseded.has(s.id)).map(s => ({
    id: sourceKey(s.id), path: s.imported_path ?? insertionEventRel(s), title: s.title, parsed: record.documentLinks.get(`source:${s.id}`)!,
  }))];
  for (const doc of linkDocuments) {
    const targets = doc.path.startsWith("memory/") ? new Set<string>() : undefined;
    if (targets) memoryTargets.set(doc.id, targets);
    for (const link of resolveDocumentLinks(doc, doc.parsed, linkResolver))
      if (nodes.has(link.target)) {
        addEdge(doc.id, link.target, link.evidence);
        targets?.add(link.target);
      }
    // An assertion citation is grounding, not an openable node. Keep its
    // entity connections alongside the links written directly in the note.
    for (const id of doc.parsed.citations) {
      const assertion = byAssertion.get(resolveAssertionIdIn(revoked, id));
      if (!assertion) continue;
      for (const entity of resolvedEntities(assertion)) if (nodes.has(entity.id)) {
        addEdge(doc.id, entity.id, { assertion: assertion.id, path: doc.path, text: assertion.text });
        if (entity.id !== doc.id) targets?.add(entity.id);
      }
    }
  }

  // Self is still an ordinary, searchable assertion entity. It is omitted
  // only from this visual projection because it is the implicit hub of a
  // personal vault and otherwise connects to nearly everything. Identity
  // comes from the trusted user-authored bootstrap assertion, never a label
  // match. Historical declarations are all hidden so a rename cannot bring
  // an obsolete self node back.
  const declarations = userIdentityDeclarationsFromEvents(assertions, sourceByInsertion);
  const self = new Set(declarations.map((row) => resolve({ id: row.entity_id, label: row.name }).id));
  // Share the same identity with the note reader: self mentions stay prose,
  // including historical names and entity aliases, rather than dead ends
  // in its graph-backed link walk. This does not alter the layout hash.
  const selfIds = new Set(self);
  const selfNames = new Set<string>();
  for (const row of declarations) {
    selfIds.add(row.entity_id);
    for (const name of [row.name, ...row.aliases]) selfNames.add(name);
  }
  for (const assertion of assertions) for (const entity of assertion.entities) {
    const canonical = resolve(entity);
    if (self.has(canonical.id)) {
      selfIds.add(entity.id); selfNames.add(entity.label); selfNames.add(canonical.label);
    }
  }
  const userNote = { ids: [...selfIds].sort(), names: [...selfNames].sort() };
  for (const node of nodes.values()) if (isUserNode(node, userNote)) self.add(node.id);
  const visibleEdges = edges.filter((edge) => !self.has(edge.source) && !self.has(edge.target));
  for (const node of nodes.values()) node.degree = 0;
  for (const edge of visibleEdges) {
    nodes.get(edge.source)!.degree++;
    nodes.get(edge.target)!.degree++;
  }
  // A source whose every entity was self loses all its edges here and
  // would vanish; it draws anyway, as a lone point: it is a filed arrival
  // (Nick, 2026-09-05 — a "Security alert" mail about his own account,
  // cited by an assertion, lit nothing from the list). Entities and topics
  // still need an edge. Memory notes also stay visible without edges because
  // they are the workspace catalogue. An entity is always edged to its sources, so only
  // the about-self-alone source is cited yet at degree 0.
  const drawn = [...nodes.values()].filter((node) => !self.has(node.id) && (node.degree > 0 || node.group === "source" || node.group === "memory"))
    .sort((a, b) => a.id.localeCompare(b.id));
  const visible = new Set(drawn.map(node => node.id));
  // An entity that IS a source — a document extracted as its own subject
  // (lib/entitySourceLog.ts) — names it: the viewer draws the pair as one
  // node and opens the source. Both stay in the projection for every other
  // reader. A binding to a superseded landing follows its source's live one.
  const live = new Map<string, string>();
  for (const source of events) if (!superseded.has(source.id)) live.set(source.source_id, source.id);
  const opens = new Map<string, Map<string, string>>();
  for (const binding of record.entitySources) {
    if (!binding.bound) continue;
    const entity = nodes.get(resolve(binding.entity).id);
    const landed = sourceByInsertion.get(binding.insertion_id);
    const liveId = landed && (superseded.has(landed.id) ? live.get(landed.source_id) : landed.id);
    const insertion = liveId ? sourceByInsertion.get(liveId) : undefined;
    const source = insertion && nodes.get(sourceKey(insertion.id));
    if (!entity?.entity || !source || !visible.has(entity.id) || !visible.has(source.id)) continue;
    const held = opens.get(entity.id) ?? new Map<string, string>();
    const at = sourceMoment(insertion);
    if (!held.has(source.id) || held.get(source.id)! < at) held.set(source.id, at);
    opens.set(entity.id, held);
    source.drawnAs ??= entity.id;
  }
  for (const [id, held] of opens)
    nodes.get(id)!.opens = [...held].sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0])).map(([key]) => key);
  // Direction comes from the document, never the canonicalized graph edge.
  // A memory contributes once per visible target, including cited assertions.
  for (const [id, targets] of [...memoryTargets].sort(([a], [b]) => a.localeCompare(b))) {
    if (!visible.has(id)) continue;
    const linked = [...targets].filter(target => visible.has(target));
    const contribution = 1 / Math.sqrt(Math.max(1, linked.length));
    for (const target of linked) {
      const node = nodes.get(target)!;
      node.memorySupport = (node.memorySupport ?? 0) + contribution;
    }
  }
  visibleEdges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const hash = createHash("sha1");
  // The weights are in the hash: the viewer rebuilds on the hash, and a
  // pair cited one more time is a change in the picture it draws. The
  // layout cache is keyed by the same hash and re-simulates on a
  // weight-only change — seeded from the standing positions, so it settles
  // where it was, and rare besides: nearly every round that re-cites a pair
  // also lands a new source node.
  // A pending point is in the hash too: the round that files it changes
  // its threads, while a decline removes the spinner and leaves the source.
  hash.update("assertions/v7-memory-support\n");
  for (const node of drawn) hash.update(`${node.id}${node.pending ? " pending" : ""}${node.memberPaths ? ` ${node.memberPaths.join(" ")}` : ""}${node.memorySupport ? ` memory:${node.memorySupport}` : ""}${node.opens ? ` opens:${node.opens.join(" ")}` : ""}\n`);
  for (const edge of visibleEdges) hash.update(`${edge.source}>${edge.target}${edge.weight ? `x${edge.weight}` : ""}\n`);
  return { nodes: drawn, edges: visibleEdges, hash: hash.digest("hex").slice(0, 16), projection: "assertions",
    ...(self.size ? { userNote } : {}),
  };
}

/** A source's node — the filed-by facet from the same read the feed's rows
 * use, so a node and its row wear one filer (lib/sourceFeed.ts's
 * insertionFiler). */
function sourceNode(source: SourceMetadata, degree: number): GraphNode {
  const filer = insertionFiler(source);
  return {
    id: `source:${source.id}`,
    title: source.title,
    group: "source",
    degree,
    path: insertionEventRel(source),
    ...(source.envelope.source === "agent-chat" && typeof source.envelope.key === "string" ? { sessionId: source.envelope.key } : {}),
    band: filer.band,
    from: filer.from,
    ...(filer.via ? { via: filer.via } : {}),
    ...(filer.channel ? { source: filer.channel } : {}),
    ...(filer.sourceDetail ? { sourceDetail: filer.sourceDetail } : {}),
  };
}
