/** Assertion-native declaration of who owns a vault.
 *
 * A declaration is one immutable source insertion holding the user's own
 * words plus one natural-language assertion authored by that person. No
 * dossier, category, or name heuristic is involved: the readers here
 * recognize only that production procedure, and require the assertion, its
 * source, and their authorship to agree.
 *
 * The writer was the hosted edge's `POST /api/me` until #570 deleted it —
 * an account id from the control plane and an edge-VERIFIED email are
 * things no local install has, so for five days a new vault had no way to
 * say who it was about (#572). The local door is the desktop's first run
 * and `bigbrain whoami --declare`, and the identity it takes is ASSERTED,
 * not verified: on your own machine, what you type and what git and Claude
 * Code already believe are the same grade of evidence. The account id is
 * the owner's email — stable enough to match declarations across renames,
 * which is the only thing readers use it for.
 */

import { identityReadModel } from "./vaultReadModel";
import { createHash } from "node:crypto";
import { norm } from "./ids";
import {
  assertionEntityId,
  commitAssertionEvents,
  createAssertionEvent,
  readAssertionLog,
} from "./assertionLog";
import { appendAndProjectAssertion, projectSourceInsertion } from "./assertionProjection";
import {
  appendSourceInsertionEvent,
  commitSourceInsertionEvents,
  readSourceInsertionLog,
  sourceInsertion,
  type SourceInsertion,
} from "./insertionLog";

import { USER_IDENTITY_PROCEDURE, USER_IDENTITY_VERSION, userIdentityDeclarationsFromEvents, type UserIdentityDeclaration } from "./userIdentityPolicy";
export { USER_IDENTITY_PROCEDURE, USER_IDENTITY_VERSION, userIdentityDeclarationsFromEvents, type UserIdentityDeclaration } from "./userIdentityPolicy";

// ── the writer ──────────────────────────────────────────────────────────────

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** One field of a declaration, cleaned or refused. `[` and `]` are barred
 * because the assertion's own text wikilinks the name — a bracket in it
 * would forge a second link. */
function cleanIdentityPart(value: string, field: string): string {
  const cleaned = value.trim().replace(/\s+/gu, " ");
  if (!cleaned || cleaned.length > 200 || cleaned.includes("[") || cleaned.includes("]") || /[\n\r]/u.test(cleaned))
    throw new Error(`user-identity: invalid ${field}`);
  return cleaned;
}

function uniqueAliases(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const alias = cleanIdentityPart(value, "alias");
    const key = norm(alias);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(alias);
    }
  }
  if (out.length > 20) throw new Error("user-identity: at most 20 aliases are allowed");
  return out;
}

function sentence(name: string, aliases: readonly string[]): string {
  const also = aliases.filter((alias) => norm(alias) !== norm(name));
  return `[[${assertionEntityId(name)}|${name}]] is the owner of this BigBrain vault` +
    (also.length ? ` and is also known as ${also.map((alias) => JSON.stringify(alias)).join(", ")}` : "") +
    ".";
}

export interface UserIdentityInput {
  /** How the person writes their own name. Becomes the entity label, so
   * `hash(label)` becomes the entity id — a rename is a NEW entity, which
   * is why the door asks once and `bigbrain entity supersede` is the tool
   * for changing your mind. */
  name: string;
  /** The owner's email: the declaration's account id, and its first alias.
   * The local doors default it to the vault's git `user.email`, else the
   * signed-in Claude Code account. */
  email: string;
  aliases?: readonly string[];
  now?: Date;
}

/**
 * Append one declaration: the person's own words as an immutable insertion,
 * then one assertion citing it. Exact retries converge on the same source
 * id, so a lost response is safe to replay; a changed name or alias set
 * makes a NEW declaration and never rewrites the old one — `latestUserIdentity`
 * reads the newest, and the history stays as the record of what was said when.
 */
export function declareUserIdentity(root: string, input: UserIdentityInput): UserIdentityDeclaration {
  const name = cleanIdentityPart(input.name, "name");
  const email = cleanIdentityPart(input.email, "email");
  // The name is not an alias of itself: a dossier's title rides along on
  // the doors (#683), and the sentence below already leaves it out.
  const aliases = uniqueAliases([email, ...(input.aliases ?? [])].filter((alias) => norm(alias) !== norm(name)));
  const sourceId = `identity-${hash(JSON.stringify({ account: email, name, aliases })).slice(0, 24)}`;

  const prior = readSourceInsertionLog(root, { strict: true })
    .find((source) => source.source_id === sourceId);
  const createdAt = prior?.received_at ?? input.now?.toISOString() ?? new Date().toISOString();
  const body = `${name} says they are the owner of this BigBrain vault` +
    (aliases.length ? ` and are known by ${aliases.map((alias) => JSON.stringify(alias)).join(", ")}` : "") +
    ".";
  const source: SourceInsertion = prior ?? {
    ...sourceInsertion({
      id: sourceId,
      title: `About ${name}`,
      kind: "identity-declaration",
      source: "user-bootstrap",
      from: email,
      from_kind: "person",
      received: createdAt,
      identity_name: name,
      identity_aliases: aliases,
    }, body),
    author: { kind: "user", id: email },
  };
  const sourceResult = appendSourceInsertionEvent(root, source);
  projectSourceInsertion(root, source);

  const entity = { id: assertionEntityId(name), label: name };
  const event = createAssertionEvent({
    text: sentence(name, aliases),
    entities: [entity],
    sources: [source.id],
    author: { kind: "user", id: email },
    confidence: "direct",
    created_at: createdAt,
    produced_by: { procedure: USER_IDENTITY_PROCEDURE, version: USER_IDENTITY_VERSION },
  }, new Map([[source.id, source]]));
  const assertionResult = appendAndProjectAssertion(root, event);

  commitSourceInsertionEvents(root, [sourceResult.path], "identity: record user declaration");
  commitAssertionEvents(root, [assertionResult.path], "identity: assert vault owner");
  return {
    account_id: email,
    entity_id: entity.id,
    name,
    aliases,
    assertion_id: event.id,
    source_id: source.source_id,
    insertion_id: source.id,
    created_at: createdAt,
  };
}

// ── the readers ─────────────────────────────────────────────────────────────

/** All valid declarations, oldest first, with authorship and evidence read
 * together from the published revision. Writers still validate the raw log. */
export function userIdentityDeclarations(root: string): UserIdentityDeclaration[] {
  try { return identityReadModel(root); }
  catch {
    // Preserve strict identity validation even when an unrelated event kind
    // blocks reconciliation. A vault without a declaration needs no sources.
    const assertions = readAssertionLog(root, { strict: true });
    if (!assertions.some(a => a.produced_by.procedure === USER_IDENTITY_PROCEDURE)) return [];
    const sources = new Map(readSourceInsertionLog(root, { strict: true }).map(s => [s.id, s]));
    return userIdentityDeclarationsFromEvents(assertions, sources);
  }
}

export function latestUserIdentity(
  root: string,
  match: { account_id?: string; alias?: string } = {}
): UserIdentityDeclaration | undefined {
  const account = match.account_id && norm(match.account_id);
  const alias = match.alias && norm(match.alias);
  return userIdentityDeclarations(root).filter((row) =>
    (!account || norm(row.account_id) === account) &&
    (!alias || row.aliases.some((value) => norm(value) === alias))
  ).at(-1);
}
