// Debounced search state for the desktop recent palette and legacy SearchTab.
// The floating popup uses its paginated controller in floatingSearch.svelte.ts. Pure request decisions live in ./omnibox.ts.
import { api } from "./api";
import { app } from "./store.svelte";
import { createSearchRunner, type SearchFailure } from "./omnibox";
import type { NoteMeta, RecentEntry } from "./types";

export interface SearchHit {
  recentEntry?: RecentEntry;
  annotationParent?: string;
  searchImportance?: number;
  evidence?: "memory" | "agent-conversation" | "agent-answer";
  sessionId?: string;
  agentState?: import("./agentAppearance").AgentVisualState;
  agentStatus?: string;
  pilotPhase?: import("./pilotAppearance").PilotVisualPhase;
  threadCount?: number;
  dir: string;
  note: NoteMeta;
  title: string;
  snippet: string;
  /** An entity hit found through one of its aliases: the label the query
   * met. Rendered "Trail Map → TrailAtlas", so a fold shows it knows (#728). */
  alias?: string;
  // The FILED BY facet, stamped by /api/search on source-insertion hits
  // (absent on entity hits — an entity has many filers and no one chip).
  // Present so a surface governed by the settings → vault Filter (the
  // recent palette) can hold search to the same choices.
  band?: RecentEntry["band"];
  from?: string;
  via?: string;
  source?: string;
}

export const searchOverlay = $state({ open: false });

export const results = $state({
  query: "", // the query these hits are FOR — may lag the input mid-debounce
  hits: [] as SearchHit[],
  building: false,
  /** The bounded failure posture (#456): "slow" when the request hit the
   * runner's deadline, "error" when the server refused or the wire broke.
   * "" is the healthy state. SearchResults renders these with a retry. */
  failed: "" as SearchFailure,
  /** Keyboard selection over the hits: the omnibox selects the first of
   * its results when they settle. The palette owns its cursor. */
  sel: -1,
});

/** The runner owns debounce, superseded-request cancellation, and deadline. */
const run = createSearchRunner<SearchHit>({
  debounceMs: 50,
  cacheMs: 15_000,
  search: (key, signal) => {
    const { source, q, limit } = JSON.parse(key);
    return api.search(q, limit, signal, source);
  },
  settle: ({ query, hits, failed }) => {
    results.query = JSON.parse(query).q;
    results.hits = hits;
    results.building = false;
    results.failed = failed;
    results.sel = hits.length ? 0 : -1; // every settled query starts on its first hit
  },
  pending: () => {
    results.building = true;
    results.failed = "";
  },
  cleared: () => {
    results.query = "";
    results.hits = [];
    results.building = false;
    results.failed = "";
    results.sel = -1;
  },
});

export function runSearch(q: string): void {
  // This full-list search belongs to the desktop palette.
  // A live vault revision invalidates reuse immediately, including memory edits.
  run(q.trim() ? JSON.stringify({ source: app.searchSource, q: q.trim(),
    limit: 100, revision: app.rev }) : "");
}

// The omnibox's CAPTURE — `capture` state and ingest(), the typed line
// POSTed through /api/drop with the band under the hits and ⌘↵ — came out
// on 2026-09-06 (Nick: "i don't think anyone uses that"). ./omnibox.ts
// keeps composeCapture and the predicates, tested, should it return.
