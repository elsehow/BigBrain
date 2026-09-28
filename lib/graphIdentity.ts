/** A graph node can represent a thread or a managed session with several
 * source records. Every selection surface resolves those aliases alike. */
export interface GraphIdentity {
  id: string;
  path?: string | null;
  memberPaths?: string[];
  sourcePaths?: string[];
}

export const findNode = (nodes: readonly GraphIdentity[], key: string): number =>
  nodes.findIndex(n => n.id === key || n.path === key || n.memberPaths?.includes(key) || n.sourcePaths?.includes(key));

/** Build once for a batch of lookups. First node wins, just like findNode,
 * including when an earlier alias collides with a later node's ID.
 * Explicit snapshots avoid stale caches when graph builders mutate arrays. */
export function graphIdentityIndex(nodes: readonly GraphIdentity[]): Map<string, number> {
  const index = new Map<string, number>();
  nodes.forEach((node, i) => {
    for (const key of [node.id, node.path, ...(node.memberPaths ?? []), ...(node.sourcePaths ?? [])]) {
      if (typeof key === "string" && !index.has(key)) index.set(key, i);
    }
  });
  return index;
}
