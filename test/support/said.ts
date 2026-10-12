/** Assertions of the non-prose kinds, made and projected in one call: what a
 * test says about its fixture (lib/assertionLog.ts). Every one takes the
 * author, time and producer it should carry, and defaults them. */

import {
  createDeclineAssertion, createIdentityAssertion, createRetraction, sameAs,
  type AssertionEntity, type AssertionProduction, type DeclineAssertion, type Identity, type IdentityAssertion,
  type RetractionAssertion,
} from "../../lib/assertionLog";
import { appendAndProjectAssertion, projectedSourcesById } from "../../lib/assertionProjection";
import type { EventAuthor } from "../../lib/insertionLog";

export interface Said { author?: EventAuthor; created_at?: string; produced_by?: AssertionProduction }

let tick = 0;
const said = (o: Said) => ({
  author: o.author ?? { kind: "user", id: "owner" } as EventAuthor,
  created_at: o.created_at ?? new Date(Date.UTC(2026, 8, 1) + tick++ * 1000).toISOString(),
  produced_by: o.produced_by ?? { procedure: "test", version: "1" },
});

/** Nothing in these sources is worth asserting. */
export function decline(root: string, sources: readonly string[], reason = "nothing to file", o: Said = {}): DeclineAssertion {
  const event = createDeclineAssertion({ sources: [...sources], reason, ...said(o) }, projectedSourcesById(root, [...sources]));
  appendAndProjectAssertion(root, event);
  return event;
}

/** `retracts` no longer stands; `superseded_by` stands in its place. */
export function retract(root: string, retracts: string, o: Said & { superseded_by?: string; reason?: string } = {}): RetractionAssertion {
  const event = createRetraction({ retracts, reason: o.reason ?? "withdrawn", ...(o.superseded_by ? { superseded_by: o.superseded_by } : {}), ...said(o) });
  appendAndProjectAssertion(root, event);
  return event;
}

/** Any identity, citing `sources`. */
export function identify(root: string, identity: Identity, sources: readonly string[] = [], o: Said = {}): IdentityAssertion {
  const event = createIdentityAssertion({ identity, sources: [...sources], ...said(o) }, projectedSourcesById(root, [...sources]));
  appendAndProjectAssertion(root, event);
  return event;
}

/** The label names the entity. */
export const alias = (root: string, label: string, entity: AssertionEntity, o: Said = {}): IdentityAssertion =>
  identify(root, sameAs(label, entity), [], o);

/** The entity is the source. */
export const bind = (root: string, entity: AssertionEntity, insertionId: string, o: Said = {}): IdentityAssertion =>
  identify(root, { says: "is-source", entity }, [insertionId], o);

/** The two entities are not one thing. */
export const distinct = (root: string, a: AssertionEntity, b: AssertionEntity, o: Said = {}): IdentityAssertion =>
  identify(root, { says: "distinct", entities: [a, b] }, [], o);

/** A model's score, or a person's word, that two sources are one work. */
export const copies = (root: string, a: string, b: string, word: { score: number } | { same: boolean }, o: Said = {}): IdentityAssertion =>
  identify(root, "score" in word ? { says: "copy", score: word.score } : { says: word.same ? "copy" : "not-copy" }, [a, b],
    "score" in word ? { author: { kind: "model", id: "judge", invocation_id: "run-1" }, ...o } : o);
