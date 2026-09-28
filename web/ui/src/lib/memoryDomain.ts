/** A selected memory reveals two hops. Support counts distinct direct neighbors,
 * so a popular hub alone cannot make its entire neighborhood foreground. */
export function memoryDomain(adj: readonly (readonly number[])[], root: number, excluded: ReadonlySet<number> = new Set()) {
  const direct = new Set((adj[root] ?? []).filter(i => i !== root && !excluded.has(i)));
  const second = new Map<number, number>();
  for (const first of direct) {
    for (const i of new Set(adj[first])) {
      if (i === root || direct.has(i) || excluded.has(i)) continue;
      second.set(i, (second.get(i) ?? 0) + 1);
    }
  }
  return { root, direct, second };
}
export type MemoryDomain = ReturnType<typeof memoryDomain>;

export function memoryDomainDepth(domain: MemoryDomain, i: number, hovered: number, adj: readonly (readonly number[])[]): number {
  if (i === domain.root || i === hovered) return 0;
  if (domain.direct.has(i)) return domain.second.has(hovered) && adj[hovered]?.includes(i) ? 0 : -12;
  const support = domain.second.get(i);
  if (!support) return -240;
  if (domain.direct.has(hovered) && adj[hovered]?.includes(i)) return -60;
  return support > 1 ? -165 : -224;
}

/** Keep the resting domain legible: only the memory's own spokes persist. */
export function memoryDomainEdge(domain: MemoryDomain, a: number, b: number, hovered: number): number {
  if (a === domain.root && domain.direct.has(b) || b === domain.root && domain.direct.has(a)) return 1;
  if (a !== hovered && b !== hovered) return 0;
  if (domain.direct.has(a) && (domain.direct.has(b) || domain.second.has(b))
    || domain.direct.has(b) && domain.second.has(a)) return 1;
  return 0;
}
