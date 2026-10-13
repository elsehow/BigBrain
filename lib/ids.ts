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
 * The branded ids below are distinct types the parsers alone make
 * (docs/plans/2026-10-11-field-of-assertions.md, Types): a string becomes
 * an `EntityId` by passing `parseEntityId`, so handing an insertion id to a
 * function that wants an entity's does not compile. Code that has not been
 * brought under them yet keeps taking `string`; a brand widens to it.
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

/** An event in a log the assertion kinds replaced (lib/retiredLogs.ts): what
 * `bigbrain migrate` converted an assertion from (its `migrated_from`). */
export const RETIRED_EVENT_ID = /^(dec|rev|eal|esb|scp|efr)_[a-f0-9]{24}$/u;

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

/** An arrival in `log/insertions/`: `ins_` + 24 hex. */
export const INS_ID = /^ins_[a-f0-9]{24}$/u;

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };
export type InsertionId = Brand<string, "InsertionId">;
export type AssertionId = Brand<string, "AssertionId">;
export type EntityId = Brand<string, "EntityId">;
/** The id an arrival's envelope names it by (`source_id`), which the
 * sender chooses: any single line. */
export type EnvelopeId = Brand<string, "EnvelopeId">;
/** A path inside the vault: relative, `/`-separated, never leaving it. */
export type VaultPath = Brand<string, "VaultPath">;

const parser = <T extends string>(what: string, ok: (value: string) => boolean) => (value: string): T => {
  if (!ok(value)) throw new Error(`not ${what}: ${JSON.stringify(value).slice(0, 80)}`);
  return value as T;
};
export const parseInsertionId = parser<InsertionId>("an insertion id", (v) => INS_ID.test(v));
export const parseAssertionId = parser<AssertionId>("an assertion id", (v) => AST_ID.test(v));
export const parseEntityId = parser<EntityId>("an entity id", (v) => ENT_ID.test(v));
export const parseEnvelopeId = parser<EnvelopeId>("an envelope id", (v) => v !== "" && !/[\r\n]/u.test(v));
export const parseVaultPath = parser<VaultPath>("a vault path", (v) => v !== "" && !v.startsWith("/") && !v.includes("\\")
  && v.split("/").every((part) => part !== "" && part !== "." && part !== ".."));

/** An entity label's canonical form: trimmed, lowercased, inner whitespace
 * collapsed. */
export const norm = (value: string): string =>
  value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
