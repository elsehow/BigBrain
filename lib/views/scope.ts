/** scope.ts — the privacy rules as types only one function makes
 * (docs/plans/2026-10-11-field-of-assertions.md, "Types" and "Scopes").
 *
 * - `Live`: retractions applied. An assertion retracted, or citing only
 *   landings a later landing of their source superseded, is as if never
 *   made. Drawing takes it.
 * - `InLens<L>`: of those, every assertion citing at least one source and
 *   every source it cites a member of lens L: the "all" rule. A lens never
 *   shows an assertion that would reveal a note outside it. A lens draws only
 *   this.
 * - `Publishable<S>`: of the live ones, every assertion whose every cited
 *   source is shared to server S. Publishing takes only this.
 *
 * A caller that skips the filter does not compile; getting past one takes a
 * cast, and a cast can be found.
 */
import { assertionSourceReferences, type AssertionEvent, type AssertionSourceReference, type IdentityAssertion } from "../assertionLog";
import { assertionSuperseded } from "../sourceSupersede";

declare const scoped: unique symbol;
/** A scope's assertions, oldest first, as the record holds them. */
type Scoped<Tag> = readonly AssertionEvent[] & { readonly [scoped]: Tag };

export type Live = Scoped<"live">;
/** A lens's assertions, and its members (by source id): the sources it draws. */
export type InLens<L extends string> = Scoped<{ lens: L }> & { readonly members: ReadonlySet<string> };
export type Publishable<S extends string> = Scoped<{ server: S }>;
/** What may be drawn: the whole of what is live, or a lens of it. */
export type Drawable = Live | InLens<string>;

/** The live assertions: none retracted (the record's rows already are not),
 * none whose every cited landing has been superseded. */
export function liveOf(record: { rows: readonly AssertionEvent[]; superseded: ReadonlySet<string>; sources: ReadonlyMap<string, unknown> }): Live {
  return record.rows.filter((row) => !assertionSuperseded(
    assertionSourceReferences(row).map((ref) => ref.insertion_id), record.superseded, (id) => record.sources.has(id),
  )) as readonly AssertionEvent[] as Live;
}

/** Every cited source passes, and there is one. */
const all = (row: AssertionEvent, passes: (ref: AssertionSourceReference) => boolean): boolean => {
  const refs = assertionSourceReferences(row);
  return refs.length > 0 && refs.every(passes);
};

/** Lens `lens`'s assertions: those every source of which is a member
 * (`members`, by source id, as a lens names its notes). */
export function inLens<L extends string>(live: Live, _lens: L, members: ReadonlySet<string>): InLens<L> {
  return Object.assign(live.filter((row) => all(row, (ref) => members.has(ref.source_id))), { members }) as readonly AssertionEvent[] as InLens<L>;
}

/** Server `server`'s share of the live assertions: those every source of
 * which `shared` says is shared there, exactly as cited. */
export function publishableTo<S extends string>(live: Live, _server: S, shared: (ref: AssertionSourceReference) => boolean): Publishable<S> {
  return live.filter((row) => all(row, shared)) as readonly AssertionEvent[] as Publishable<S>;
}

/** Server `server`'s share of the identity assertions: those citing sources,
 * every one of them shared there (step 7). An alias, which cites nothing,
 * never is. */
export type PublishableIdentities<S extends string> = readonly IdentityAssertion[] & { readonly [scoped]: { server: S; identity: true } };
export function identitiesPublishableTo<S extends string>(identities: readonly IdentityAssertion[], _server: S,
  shared: (ref: AssertionSourceReference) => boolean): PublishableIdentities<S> {
  return identities.filter((e) => e.sources.length > 0 && e.sources.every(shared)) as readonly IdentityAssertion[] as PublishableIdentities<S>;
}
