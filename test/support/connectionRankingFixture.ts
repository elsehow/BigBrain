/** Fabricated local neighborhood beside an unrelated, globally prominent hub. */
export function connectionRankingFixture(localCount = 3) {
  const local = ["partner", "clinic", "school", ...Array.from({ length: Math.max(0, localCount - 3) }, (_, i) => `local-${i}`)];
  const distant = Array.from({ length: 80 }, (_, i) => `distant-${i}`);
  const ids = ["focus", ...local, "hub", "rare", "local-note", ...distant];
  return { nodes: ids.map(id => ({ id, title: id, path: `entities/${id}.md`, group: "entity" })),
    edges: [
      ...[...local, "hub", "rare", "local-note"].map(target => ({ source: "focus", target })),
      ...local.flatMap((source, i) => local.slice(i + 1).map(target => ({ source, target }))),
      ...local.map(source => ({ source, target: "local-note" })),
      ...distant.map(target => ({ source: "hub", target })),
    ] };
}
