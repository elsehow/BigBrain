// Pure logic behind the omnibox (phase 4 item 4 of
// docs/plans/2026-07-25-lake-vault-queue.md). Kept out of the Svelte
// components so it's testable with plain `bun test`; the reactive wiring
// (the debounced fetch) lives in ./omnibox.svelte.ts.
//
// The CAPTURE half — the field doubling as a capture box, ⌘↵ and the band
// under the hits — came out of the UI on 2026-09-06 (Nick: "i don't think
// anyone uses that"). isIngestShortcut, shouldOfferIngest and
// composeCapture stay here, tested, should it return; nothing calls them.

import { slug } from "../../../../lib/slug";
import { fmBody, fmSerialize } from "../../../../lib/wire";

export interface SearchHitLike {
  note: { path: string };
}

/** ⌘/Ctrl+Enter is the explicit "ingest this" shortcut — always available,
 * regardless of whether the query currently matches anything (the mockup's
 * "or on explicit modifier" clause). Plain Enter is left for opening the
 * top hit (topHitPath below), so the two keys never fight over one
 * keystroke. */
export function isIngestShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}

/** Is the platform's COMMAND modifier held — ⌘ on a Mac, Ctrl elsewhere —
 * and ONLY that one? The global keys (⌘K, ⌘,) used to accept either, which
 * on a Mac made Ctrl+K a second search key. It is not free there: every
 * Cocoa text field binds Ctrl+K to kill-to-end-of-line (the emacs set,
 * with Ctrl+A/E/D/H…), so typing it into a note field teleported the
 * cursor to the search bar instead. On Linux/Windows
 * Ctrl IS the command key and ⌘/Win never reaches the page. */
export function commandKey(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">, mac: boolean): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Plain Enter "opens the selection" — with no arrow-key highlight model in
 * this UI, the selection is the top (strongest) search hit. `null` when
 * there is nothing to open, so the caller can leave Enter a no-op. */
export function topHitPath(hits: readonly SearchHitLike[]): string | null {
  return hits[0]?.note.path ?? null;
}

/** CAPTURE shows for any settled query, matched or not (2026-08-10,
 * restoring the mockup: its results screen carries a CAPTURE band under a
 * list of ONE hit, not only under an empty one). It had been gated on zero
 * hits, which made capture a consolation prize — "nothing found, want to
 * add it?" — when the omnibox's actual contract is that a typed line is
 * always both a search and something you can keep. Finding a near-miss is
 * exactly when you learn the note you wanted is missing.
 *
 * `hitsQuery` is the query the hit list is actually FOR (it lags `query`
 * while a search is in flight), so the row never offers to capture text
 * that a different, still-loading search is about. */
export function shouldOfferIngest(query: string, hitsQuery: string, building: boolean): boolean {
  const q = query.trim();
  return q.length > 0 && !building && hitsQuery === q;
}

// ── the debounced, cancelling search runner (#456) ─────────────────────────
// One query owns the omnibox at a time. A keystroke during the debounce
// means the earlier query never even leaves the client; a keystroke while a
// request is on the wire ABORTS that request rather than letting stale work
// queue behind the final query on the server. And a search may not stay
// "Searching…" forever: past the deadline the runner settles into an honest
// failure posture the view can render with a retry.
//
// Pure of Svelte on purpose: the hooks write whatever reactive state the
// caller owns (./omnibox.svelte.ts wires them to `results`), so this whole
// state machine is testable with plain `bun test` and fake search functions.

export type SearchFailure = "" | "slow" | "error";

export interface SearchRunnerHooks<H> {
  search: (q: string, signal: AbortSignal) => Promise<{ hits: H[] }>;
  /** The latest query settled — with hits, or with its failure posture.
   * Never called for a superseded query. */
  settle: (outcome: { query: string; hits: H[]; failed: SearchFailure }) => void;
  /** A fresh non-empty query is debouncing or on the wire. */
  pending: () => void;
  /** The box emptied; any in-flight request is already aborted. */
  cleared: () => void;
  debounceMs?: number | ((query: string) => number);
  timeoutMs?: number;
  /** Reuse a completed query briefly. Include source/revision in opaque keys. */
  cacheMs?: number;
}

export function createSearchRunner<H>(hooks: SearchRunnerHooks<H>): (query: string) => void {
  const debounceMs = hooks.debounceMs ?? 150;
  const timeoutMs = hooks.timeoutMs ?? 12_000;
  const cacheMs = hooks.cacheMs ?? 0;
  const cache = new Map<string, { at: number; hits: H[] }>();
  let token = 0;
  let inflight: AbortController | null = null;
  return (query: string): void => {
    const q = query.trim();
    const mine = ++token;
    inflight?.abort(); // cancel stale work immediately, before the next debounce
    inflight = null;
    if (!q) {
      hooks.cleared();
      return;
    }
    const held = cache.get(q);
    if (held && Date.now() - held.at < cacheMs) {
      cache.delete(q); cache.set(q, held);
      hooks.settle({ query: q, hits: held.hits, failed: "" });
      return;
    }
    cache.delete(q);
    hooks.pending();
    setTimeout(() => {
      if (mine !== token) return; // superseded during the debounce — no request ever left
      inflight?.abort(); // a later query owns the omnibox; stale wire work is cancelled
      const ctl = new AbortController();
      inflight = ctl;
      const deadline = setTimeout(() => ctl.abort(), timeoutMs);
      hooks
        .search(q, ctl.signal)
        .then((r) => {
          if (mine !== token) return;
          if (cacheMs > 0) {
            cache.set(q, { at: Date.now(), hits: r.hits });
            if (cache.size > 32) cache.delete(cache.keys().next().value!);
          }
          hooks.settle({ query: q, hits: r.hits, failed: "" });
        })
        .catch(() => {
          if (mine !== token) return; // an aborted predecessor stays silent
          hooks.settle({ query: q, hits: [], failed: ctl.signal.aborted ? "slow" : "error" });
        })
        .finally(() => {
          clearTimeout(deadline);
          if (inflight === ctl) inflight = null;
        });
    }, typeof debounceMs === "function" ? debounceMs(q) : debounceMs);
  };
}

export interface Capture {
  filename: string;
  content: string;
}

/** Compose the raw query text into a droppable markdown item — the same
 * frontmatter-then-body shape every other capture path uses (DropZone,
 * `bigbrain drop`), landing through the existing /api/drop. No URL
 * fetching, no client-side enrichment: "send as-is" is the phase-4
 * contract — the item is data, triage decides what it is. `opts` lets
 * tests pin the date; real calls let it default.
 *
 * We mint NO `id`: the lake's exact-dupe identity is the sha256 of the
 * payload as sent (lib/intake.ts), so a client-minted id — carrying a
 * timestamp — would make every repeat capture of identical text land as a
 * fresh reference. `stampIntake`/`ensureItemId` generate one server-side
 * when the payload carries none, same rule as the extension and DropZone. */
export function composeCapture(text: string, opts: { now?: Date } = {}): Capture {
  const body = text.trim();
  const title = (body.split("\n")[0] ?? "").slice(0, 80).trim() || "capture";
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const fm = fmSerialize([
    ["kind", "capture"],
    ["title", title],
    ["date", date],
  ]);
  return {
    filename: `${slug(title, { maxLen: 60, fallback: "capture" })}.md`,
    content: fmBody(fm, body),
  };
}
