/** Workbench home: memories first, their direct evidence next, the rest below. */
export function memoryHomeDepth(groups: readonly string[], adjacency: readonly (readonly number[])[]): Float32Array {
  const heights = new Float32Array(groups.length).fill(-100);
  groups.forEach((group, i) => {
    if (group !== 'memory') return;
    heights[i] = 64;
    for (const neighbor of adjacency[i] ?? []) if (groups[neighbor] !== 'memory') heights[neighbor] = -18;
  });
  return heights;
}
