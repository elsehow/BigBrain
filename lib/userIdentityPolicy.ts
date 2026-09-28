/** Recognize identity declarations from events without opening a vault or writing. */
import { assertionEntityId, assertionSourceReferences, type AssertionEvent } from "./assertionLog";
import type { SourceMetadata } from "./insertionLog";
import { norm } from "./ids";

export const USER_IDENTITY_PROCEDURE = "user-identity-bootstrap";
export const USER_IDENTITY_VERSION = "1";

export interface UserIdentityDeclaration {
  account_id: string;
  entity_id: string;
  name: string;
  aliases: string[];
  assertion_id: string;
  source_id: string;
  insertion_id: string;
  created_at: string;
}

function declarationOf(
  assertion: AssertionEvent,
  sources: ReadonlyMap<string, SourceMetadata>
): UserIdentityDeclaration | undefined {
  if (assertion.author.kind !== "user" ||
      assertion.produced_by.procedure !== USER_IDENTITY_PROCEDURE ||
      assertion.produced_by.version !== USER_IDENTITY_VERSION ||
      assertion.entities.length !== 1) return undefined;
  const refs = assertionSourceReferences(assertion);
  if (refs.length !== 1) return undefined;
  const source = sources.get(refs[0]!.insertion_id);
  if (!source || source.source_id !== refs[0]!.source_id || source.author.kind !== "user" ||
      source.author.id !== assertion.author.id || source.envelope["kind"] !== "identity-declaration" ||
      source.envelope["source"] !== "user-bootstrap") return undefined;
  const rawName = source.envelope["identity_name"];
  const rawAliases = source.envelope["identity_aliases"];
  if (typeof rawName !== "string" || !Array.isArray(rawAliases) ||
      !rawAliases.every((alias) => typeof alias === "string")) return undefined;
  const entity = assertion.entities[0]!;
  if (entity.id !== assertionEntityId(rawName) || norm(entity.label) !== norm(rawName)) return undefined;
  return {
    account_id: assertion.author.id,
    entity_id: entity.id,
    name: rawName,
    aliases: rawAliases as string[],
    assertion_id: assertion.id,
    source_id: source.source_id,
    insertion_id: source.id,
    created_at: assertion.created_at,
  };
}

/** Projection builders already hold both logs in memory; keep identity policy
 * reusable without making a graph build walk the append-only record twice. */
export function userIdentityDeclarationsFromEvents(
  assertions: readonly AssertionEvent[],
  sources: ReadonlyMap<string, SourceMetadata>
): UserIdentityDeclaration[] {
  return assertions
    .flatMap((assertion) => declarationOf(assertion, sources) ?? [])
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.assertion_id.localeCompare(b.assertion_id));
}

