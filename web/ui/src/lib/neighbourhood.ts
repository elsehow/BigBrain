// The note view's local cut of the ONE /api/graph dataset: the open note,
// its 1-hop neighbours, and every edge among them (neighbour↔neighbour
// links included — that's the local structure). Pure, split out of
// the note's neighbourhood panel (NoteNeighbours.svelte, retired 2026-09-06:
// the ground graph with the camera on the note IS the neighbourhood now)
// so plain `bun test` can assert on it. findNode still serves LinkGraph;
// the cut is kept, tested, for the next surface that wants a local graph.
//
// The open note is resolved by id OR by `path`. In the legacy link graph a
// node's id IS the vault-relative path, so `id === path` was the whole
// join. The assertion projection ids sources as `source:<insertion id>`
// and entities by entity id, and carries the openable note in `path`
// (insertionEventRel / assertionEntityPath) — the same value the feed's
// rows and the graph's click-through navigate to, so it is the join key
// here too. #426 hid the neighbourhood on source notes because this
// resolution didn't exist yet; it does now.

import { filerChips, hiddenFilerNodeIds, offFilers } from "./feed";
import type { GraphData } from "./types";

import { findNode } from "../../../../lib/graphIdentity";
export { findNode } from "../../../../lib/graphIdentity";

export function neighbourhoodCut(g: GraphData, path: string): GraphData | null {
  const centre = g.nodes[findNode(g.nodes, path)];
  if (!centre) return null;
  const keep = new Set([centre.id]);
  for (const e of g.edges) {
    if (e.source === centre.id) keep.add(e.target);
    if (e.target === centre.id) keep.add(e.source);
  }
  if (keep.size === 1) return null; // nothing linked yet
  return {
    nodes: g.nodes.filter((n) => keep.has(n.id)),
    edges: g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    // Its own structure key so the canvas rebuilds when the cut changes.
    // The nodes keep their positions from the FULL graph, so the panel is
    // a zoom into the same map rather than a separate little diagram — a
    // note sits where you last saw it, and fit() frames the neighbourhood.
    hash: `${g.hash}~${centre.id}`,
  };
}

/** The FILED BY filter reaching into the cut (Nick, 2026-08-20): node ids
 * to hide, from the SAME choices the home screen's band toggles
 * (lib/filerChoices.svelte.ts) and the same per-label defaults — so a
 * filer switched off on home is off in every neighbourhood too. The open
 * note itself is always exempt: you are looking at it, and hiding the
 * centre of its own neighbourhood answers no question anyone asked. */
export function neighbourhoodHidden(
  cut: GraphData,
  path: string,
  choices: Readonly<Record<string, boolean>>
): Set<string> {
  const off = offFilers(filerChips([], cut.nodes), choices);
  const hidden = hiddenFilerNodeIds(cut.nodes, off);
  const centre = cut.nodes[findNode(cut.nodes, path)];
  if (centre) hidden.delete(centre.id);
  return hidden;
}

/** Unique nodes within a bounded hop distance, including the starting node.
 * Traversed when a note opens or its graph changes, never per frame. */
export function withinHops(adjacency: readonly (readonly number[])[], start: number, hops: number): number[] {
  if (start < 0 || start >= adjacency.length) return [];
  const seen = new Set([start]);
  let ring = [start];
  for (let hop = 0; hop < hops && ring.length; hop++) {
    const next: number[] = [];
    for (const i of ring) for (const j of adjacency[i]!) {
      if (!seen.has(j)) { seen.add(j); next.push(j); }
    }
    ring = next;
  }
  return [...seen];
}
