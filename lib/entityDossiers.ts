/**
 * entityDossiers.ts — the reference-era `entities/*.md` dossiers, read as
 * data (#683).
 *
 * The retired editor filed one dossier per entity with a title, an alias
 * list, and — on exactly one of them — `human_user: true` (#51). Nothing
 * writes a dossier any more, and no prompt or projection reads one for what
 * it says: entity identity is `hash(label)` plus the alias log
 * (lib/entityAliasLog.ts), and who the vault is about is the identity
 * declaration (lib/userIdentity.ts). What is left is one file walk shared by
 * the two doors that fold a dossier INTO the record — `bigbrain entity
 * seed-aliases` (lib/entityAliasSeed.ts, #642) and `bigbrain whoami
 * --adopt-dossier` (#683) — each an explicit act that appends events and
 * never edits the dossier. The file stays: it is the person's, and a vault
 * is never migrated (docs/design-principles.md §5).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvelope, type Envelope } from "./envelope";
import { norm } from "./ids";
import { deslug } from "./text";

/** Every entities/*.md with its parsed envelope, path-sorted. A file that
 * vanishes mid-walk is skipped, never an error. */
export function entityEnvelopes(root: string): { path: string; name: string; env: Envelope }[] {
  const out: { path: string; name: string; env: Envelope }[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(rel, e.name));
      else if (e.name.endsWith(".md")) {
        const path = join(rel, e.name);
        let raw: string;
        try {
          raw = readFileSync(join(root, path), "utf8");
        } catch {
          continue; // vanished mid-walk — skipped, never an error
        }
        out.push({ path, name: e.name, env: parseEnvelope(raw).envelope });
      }
    }
  };
  if (existsSync(join(root, "entities"))) walk("entities");
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export interface LegacyDossier {
  /** vault-relative path (entities/….md) */
  path: string;
  title: string;
  aliases: string[];
  /** `entity_type: person` in the front matter — the one kind whose
   * canonical label is its fullest name, not the dossier's title. */
  person: boolean;
  /** `human_user: true` — the editor's way of saying this dossier is the
   * vault's own user (#51). Read by the adopt door alone. */
  humanUser: boolean;
}

/** Every legacy dossier with its title and alias list, path-sorted. The
 * title is the frontmatter's or, failing that, the filename deslugged —
 * `evan-keller.md` is "evan keller", which hashes to Evan Keller's id; when
 * an alias spells the same label with its case, that spelling is kept. */
export function legacyDossiers(root: string): LegacyDossier[] {
  return entityEnvelopes(root).map(({ path, name, env }) => {
    // The reference-era editor filed source ids as aliases now and then
    // ("agent-chat-<uuid>-1-1890"); nothing will ever link one.
    const aliases = Array.isArray(env.aliases)
      ? env.aliases.map(String).map((a) => a.trim().replace(/\s+/g, " "))
        .filter((a) => a && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u.test(a))
      : [];
    const slug = deslug(name);
    const title = (typeof env.title === "string" && env.title.trim().replace(/\s+/g, " ")) ||
      aliases.find((a) => norm(a) === norm(slug)) || slug;
    return { path, title, aliases, person: env.entity_type === "person", humanUser: env.human_user === true };
  });
}

/** The dossier(s) flagged `human_user: true`, path-sorted — plural-safe,
 * as the flag always was. Empty on every vault made after the editor
 * retired, which is every vault but the hosted era's. */
export function legacyUserDossiers(root: string): LegacyDossier[] {
  return legacyDossiers(root).filter((d) => d.humanUser);
}
