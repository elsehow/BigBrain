/** Dev-only thematic geography. Never writes back to the vault's stored layout. */
export function memoryThemeLayout<T extends { id: string; group: string; x: number; y: number }>(nodes: readonly T[], adj: readonly (readonly number[])[]): { x: number; y: number }[] {
  const memories = nodes.map((n, i) => n.group === 'memory' ? i : -1).filter(i => i >= 0).sort((a, b) => nodes[a]!.id.localeCompare(nodes[b]!.id));
  if (!memories.length) return nodes.map(({ x, y }) => ({ x, y }));
  const anchors = new Map(memories.map((i, rank) => {
    const angle = rank * Math.PI * (3 - Math.sqrt(5)), radius = 260 * Math.sqrt(rank);
    return [i, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }] as const;
  }));
  const direct = nodes.map((_, i) => new Set((adj[i] ?? []).filter(j => anchors.has(j))));
  const spread = Math.max(1, ...nodes.map(n => Math.hypot(n.x, n.y)));
  const positions = nodes.map((node, i) => {
    if (anchors.has(i)) return { ...anchors.get(i)! };
    const themes = direct[i]!.size ? direct[i]! : new Set((adj[i] ?? []).flatMap(j => [...direct[j]!]));
    if (!themes.size) return { x: node.x / spread * (260 * Math.sqrt(memories.length) + 200), y: node.y / spread * (260 * Math.sqrt(memories.length) + 200) };
    const members = [...themes];
    const centroid = members.reduce((p, j) => ({ x: p.x + anchors.get(j)!.x / members.length, y: p.y + anchors.get(j)!.y / members.length }), { x: 0, y: 0 });
    // Preserve local directional structure, with a stable offset for coincident nodes.
    let hash = 0; for (const c of node.id) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) >>> 0;
    const angle = hash * 2.399963, radius = 30 + hash % 90;
    return { x: centroid.x + node.x / spread * 100 + Math.cos(angle) * radius, y: centroid.y + node.y / spread * 100 + Math.sin(angle) * radius };
  });
  // Reserve an oval around each landmark, including room below for its label.
  // Apply to every ordinary node, including notes shared by several themes.
  for (let pass = 0; pass < 12; pass++) for (let i = 0; i < nodes.length; i++) {
    if (anchors.has(i)) continue;
    const p = positions[i]!;
    for (const anchor of anchors.values()) {
      const dx = (p.x - anchor.x) / 140, dy = (p.y - anchor.y - 15) / 95;
      const distance = Math.hypot(dx, dy);
      if (distance >= 1) continue;
      const angle = distance > 0.001 ? Math.atan2(dy, dx) : i * 2.399963;
      // Small deterministic variation avoids packing notes onto a perfect ring.
      const clearance = 1.05 + (i % 7) * 0.025;
      p.x = anchor.x + Math.cos(angle) * 140 * clearance;
      p.y = anchor.y + 15 + Math.sin(angle) * 95 * clearance;
    }
  }
  return positions;
}
