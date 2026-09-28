/** Match only the vault's declared owner, never a hardcoded person or a
 * partial name. Entity paths and bare-label legacy links are both used. */
export function isUserNote(target: string, user?: { ids: readonly string[]; names: readonly string[] }): boolean {
  if (!user) return false;
  const key = target.trim().split("#")[0]!.replace(/\.md$/i, "");
  const id = key.replace(/^projection\/entities\//, "");
  if (user.ids.includes(id)) return true;
  const name = key.replace(/^entities\//, "");
  if (name.includes("/")) return false;
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return user.names.some(label => norm(label) === norm(name));
}


/** The generated memory index is also a view of the owner when its heading
 * names them. A meeting/source merely mentioning the owner remains a link. */
export function isUserNode(node: { id: string; path?: string | null; title: string }, user?: { ids: readonly string[]; names: readonly string[] }): boolean {
  return isUserNote(node.id, user) || (!!node.path && isUserNote(node.path, user))
    || (node.path === "memory/MEMORY.md" && isUserNote(node.title, user));
}
