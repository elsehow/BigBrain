/** view.ts — what a view is (docs/plans/2026-10-11-field-of-assertions.md,
 * "Stages and views"; the refactor that brings code here is
 * docs/plans/2026-10-12-stages-and-views-refactor.md).
 *
 * A view is a pure function of what was written. It is handed a snapshot,
 * never `root`: `root` reaches the disk, git and the network, and a view
 * that can reach them is not a function of the record. It writes nothing
 * but caches, so any view can be recomputed, and a bug in one never becomes
 * data. test/viewGuard.test.ts keeps every module in lib/views/ to that.
 */
import type { Database } from "bun:sqlite";

/** What was written, at one revision: the projection inside a read-only
 * transaction (lib/vaultReadModel.ts withSnapshot). Nothing read from it
 * changes while it is held, so two reads from one snapshot always agree. */
export interface Snapshot {
  readonly db: Database;
  /** The projection's coordinate: a view's cache key is (view, scope, revision). */
  readonly revision: string;
  /** Which vault's caches a decode at this revision may share: an identity,
   * never a path to read. */
  readonly cache: CacheKey;
}

declare const cacheKey: unique symbol;
export type CacheKey = string & { readonly [cacheKey]: true };

/** A pure function of a snapshot and its arguments. */
export type View<T, Args extends readonly unknown[] = []> = (snapshot: Snapshot, ...args: Args) => T;
