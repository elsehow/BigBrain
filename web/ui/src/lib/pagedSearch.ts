import { createSearchRunner, type SearchFailure, type SearchHitLike } from "./omnibox";

export interface ResultPage<H> { hits: H[]; nextOffset: number | null }
export interface PagedResults<H> {
  query: string; hits: H[]; sel: number; building: boolean;
  failed: SearchFailure; loadingMore: boolean; moreFailed: SearchFailure;
  nextOffset: number | null;
}
export function emptyPagedResults<H>(): PagedResults<H> {
  return { query: "", hits: [], sel: -1, building: false, failed: "",
    loadingMore: false, moreFailed: "", nextOffset: null };
}

/** One cancellable, cached page at a time. Appends retain the cursor and
 * deduplicate virtual threads that occur on both sides of a page boundary. */
export function createPagedSearch<H extends SearchHitLike>(state: PagedResults<H>,
  fetchPage: (query: string, offset: number, signal: AbortSignal) => Promise<ResultPage<H>>,
  options: { debounceMs?: number; timeoutMs?: number; cacheMs?: number;
    project?: (hits: H[], query: string) => H[];
    cached?: (query: string, offset: number) => ResultPage<H> | undefined } = {}) {
  let context = "";
  let offset = 0;
  let advanceFrom = -1;
  let remoteHits: H[] = [];
  let userSelected = false;
  const reconcile = () => {
    const hadNoSelection = userSelected && state.sel < 0;
    const selectedPath = state.hits[state.sel]?.note.path;
    state.hits = options.project ? options.project(remoteHits, state.query) : remoteHits;
    // Optimistic sessions arrive first, but their automatic highlight must not
    // follow them down the list when higher-ranked server results arrive.
    state.sel = !state.hits.length || hadNoSelection ? -1
      : userSelected ? Math.max(0, state.hits.findIndex(h => h.note.path === selectedPath)) : 0;
    if (state.hits.length) state.building = false;
  };
  const run = createSearchRunner<ResultPage<H>>({
    cacheMs: 15_000, ...options,
    debounceMs: key => {
      const request = JSON.parse(key);
      return request.offset || !request.query ? 0 : options.debounceMs ?? 50;
    },
    search: async (key, signal) => {
      const request = JSON.parse(key);
      return { hits: [await fetchPage(request.query, request.offset, signal)] };
    },
    pending: () => {
      if (offset) { state.loadingMore = true; state.moreFailed = ""; }
      else { state.building = !state.hits.length; state.failed = ""; }
    },
    cleared: () => { state.building = false; state.loadingMore = false; },
    settle: ({ query: key, hits: pages, failed }) => {
      const request = JSON.parse(key);
      state.building = false; state.loadingMore = false;
      if (request.offset) state.moreFailed = failed;
      else state.failed = state.hits.length ? "" : failed;
      if (failed) return;
      const advance = advanceFrom >= 0 && state.sel === advanceFrom;
      const page = pages[0];
      const seen = new Set(remoteHits.map(h => h.note.path));
      if (request.offset) remoteHits = [...remoteHits, ...page.hits.filter(h => {
        if (seen.has(h.note.path)) return false;
        seen.add(h.note.path); return true;
      })];
      else remoteHits = page.hits;
      reconcile();
      state.nextOffset = page.nextOffset;
      if (request.offset && advance) state.sel = Math.min(state.sel + 1, state.hits.length - 1);
      advanceFrom = -1;
    },
  });
  const request = () => run(JSON.stringify({ context, query: state.query, offset }));
  return {
    start(query: string, key: string) {
      context = key; offset = 0; advanceFrom = -1; userSelected = false;
      remoteHits = [];
      Object.assign(state, emptyPagedResults<H>(), { query: query.trim() });
      const cached = options.cached?.(state.query, 0);
      if (cached) {
        remoteHits = cached.hits; state.nextOffset = cached.nextOffset;
      }
      reconcile();
      request();
    },
    // Retry with the same dependency key, never a caller-reconstructed subset.
    retry() { offset = 0; advanceFrom = -1; request(); },
    select(index: number) {
      userSelected = true;
      state.sel = index;
    },
    more(advance = false) {
      if (state.building || state.failed || state.nextOffset === null) return;
      if (advance) userSelected = true;
      if (state.loadingMore) { if (advance) advanceFrom = state.sel; return; }
      offset = state.nextOffset;
      advanceFrom = advance ? state.sel : -1;
      request();
    },
    cancel() { run(""); },
    reconcile,
  };
}
