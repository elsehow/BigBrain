/** What an identifier looks like, and the canonical form entity ids are cut
 * from. No imports — every layer reads this one.
 *
 * `norm` is the load-bearing piece. An entity's id is a hash of its
 * normalized label (`assertionEntityId`, lib/assertionLog.ts) AND the
 * projection stores that same normalization as `normalized_label`, the
 * column entity lookups match on. Those two had drifted into four hand
 * copies of one line: change either alone and entity ids stop agreeing with
 * the labels that find them.
 *
 * The link patterns are global regexes shared as constants. Every caller
 * reaches them through `matchAll` or `String.replace`, neither of which
 * leaves `lastIndex` advanced between calls; an `exec` loop would, so don't
 * write one against these.
 */

/** An assertion entity: `ent_` + 20 hex. */
export const ENT_ID = /^ent_[a-f0-9]{20}$/u;

/** An assertion: `ast_` + 24 hex. */
export const AST_ID = /^ast_[a-f0-9]{24}$/u;

/** Every wikilink in assertion text — `[[target]]` or `[[target|display]]`.
 * The target is a bare label as a model writes it and an entity id once
 * intake has canonicalized it (lib/assertionAgent.ts). */
export const ENTITY_LINK = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/gu;

/** A link that already names an entity by id — `[[ent_…|display]]`. What
 * assertion text looks like AFTER intake canonicalizes it, so the rewriters
 * (entity view, supersession) match on this rather than the looser
 * `ENTITY_LINK`. */
export const ENTITY_ID_LINK = /\[\[(ent_[a-f0-9]{20})\|([^\]\n]+)\]\]/gu;

/** A memory topic's citation of an assertion — `[[ast_…]]`, display
 * optional. What the memory pass's citation gate and the graph both scan
 * for. */
export const AST_CITE = /\[\[(ast_[a-f0-9]{24})(?:\|[^\]\n]*)?\]\]/gu;

/** A memory topic's citation of an assertion held by a joined shared vault —
 * `[[shared:<connection>:ast_…]]`, the connection being this machine's id
 * for it (lib/sharedConnections.ts). Never matches `AST_CITE`, and the
 * reverse, so each gate checks its own kind (lib/sharedMemory.ts). */
export const SHARED_AST_CITE = /\[\[shared:([A-Za-z0-9-]+):(ast_[a-f0-9]{24})(?:\|[^\]\n]*)?\]\]/gu;

/** An entity label's canonical form: trimmed, lowercased, inner whitespace
 * collapsed. */
export const norm = (value: string): string =>
  value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
