/** The overview's landmarks: the memories, once the vault has any. Before the
 * first one (a fresh install, or a member who has so far only joined a
 * shared vault) every node would sink into the faint background, so entities
 * stand in, and so does each source no entity cites. */
export function overviewAnchors(groups: readonly string[], adjacency: readonly (readonly number[])[]): boolean[] {
  if (groups.includes('memory')) return groups.map(group => group === 'memory');
  return groups.map((group, i) => group === 'entity' || group === 'source' && !(adjacency[i] ?? []).some(j => groups[j] === 'entity'));
}

/** Workbench home: anchors first, their direct evidence next, the rest below. */
export function anchorHomeDepth(anchors: readonly boolean[], adjacency: readonly (readonly number[])[]): Float32Array {
  const heights = new Float32Array(anchors.length).fill(-100);
  anchors.forEach((anchor, i) => {
    if (!anchor) return;
    heights[i] = 64;
    for (const neighbor of adjacency[i] ?? []) if (!anchors[neighbor]) heights[neighbor] = -18;
  });
  return heights;
}
