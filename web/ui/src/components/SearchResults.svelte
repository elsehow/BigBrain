<script lang="ts">
  import { inspectActions } from "../lib/actionHistory.svelte";
  import { listTimestamp as timestamp } from "../lib/listTimestamp";
  import BlockScrollbar from "./BlockScrollbar.svelte";
  import AgentIndicator from "./AgentIndicator.svelte";
  import NodeIndicator from "./NodeIndicator.svelte";
  import LoadingSpinner from "./LoadingSpinner.svelte";
  import { getContext, tick } from "svelte";
  import { app } from "../lib/store.svelte";
  import type { SearchHit } from "../lib/omnibox.svelte";
  import { floatingResults as results, floatingSearch } from "../lib/floatingSearch.svelte";
  import { titleOf } from "../lib/utils";
  import { chat, refreshChats, startChat } from "../lib/pilotChat.svelte";
  import { sourceAttention, selectedReadSources, markSelectedSources } from "../lib/sourceAttention.svelte";
  import { sourceReadIndex } from "../lib/sourceReadIndex";

  import { SIDEBAR_LAYOUT, type SidebarLayout } from "../lib/sidebarLayout";
  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);

  const { hits, onopen, searchField }: { hits: SearchHit[]; onopen: (index: number) => void; searchField?: import("svelte").Snippet } = $props();
  const name = (hit: SearchHit) => hit.title || titleOf(hit.note.name);
  const kind = (hit: SearchHit) => hit.dir === "agent" ? "agent" : hit.dir === "pilot" ? "pilot" : hit.dir === "memory" ? "memory" : hit.dir === "projection/entities" ? "entity" : "source";
  const pending = $derived(results.building || results.query !== app.query.trim());
  const recent = $derived(!app.query.trim());
  const readStates = $derived(sourceReadIndex(chat.graph?.nodes ?? [], sourceAttention.rows));
  const selection = $derived(sidebar?.listSelection ?? []);
  const readable = $derived(selectedReadSources(chat.graph, selection));
  let bulkFeedback = $state(false);
  function listAction(action: "toggle" | "pilot" | "read" | "first" | "last") {
    if (!sidebar) return;
    if (action === "first" || action === "last") { floatingSearch.select(action === "first" ? 0 : Math.max(0, hits.length - 1)); return; }
    if (action === "toggle") {
      const hit = hits[results.sel]; if (!hit) return;
      const path = hit.note.path;
      sidebar.listSelection = selection.includes(path) ? selection.filter(p => p !== path) : [...selection, path];
      bulkFeedback = false;
    } else if (action === "pilot") {
      const paths = selection.length ? [...selection] : hits[results.sel] ? [hits[results.sel].note.path] : [];
      if (paths.length) void startChat(paths);
    } else if (readable.length && !sourceAttention.saving) {
      bulkFeedback = true;
      void markSelectedSources(chat.graph, false, [...selection]);
    }
  }
  $effect(() => {
    if (!sidebar) return;
    sidebar.listAction = listAction;
    return () => { sidebar.listAction = undefined; };
  });
  let viewport = $state<HTMLDivElement>();
  $effect(() => {
    const query = app.query;
    void tick().then(() => { if (viewport && query === app.query) viewport.scrollTop = 0; });
  });
  $effect(() => {
    const selected = results.sel;
    void tick().then(() => {
      const row = viewport?.querySelector<HTMLElement>(`#search-hit-${selected}`);
      if (!viewport || !row || selected !== results.sel) return;
      const top = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + row.offsetHeight > viewport.scrollTop + viewport.clientHeight)
        viewport.scrollTop = top + row.offsetHeight - viewport.clientHeight;
    });
  });
  function scroll(): void {
    if (viewport && viewport.scrollTop > 0) moreAtBottom();
  }
  function moreAtBottom(): void {
    if (viewport && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < viewport.clientHeight && !results.moreFailed)
      floatingSearch.more();
  }
</script>

<div class="search-results">
 <div class="list-title-bar" class:recents-title-bar={!!sidebar}>
  {#if sidebar}
    <div class="recents-heading"><strong>{sidebar.tab === 'recents' ? 'Recents' : 'Search'}</strong>
      {#if searchField}{@render searchField()}
      {:else if sidebar.tab === 'recents'}<button class="unread-filter" aria-pressed={!!sidebar.unreadOnly} onclick={() => sidebar.unreadOnly = !sidebar.unreadOnly}>Unread <kbd class="keyboard-hint">u</kbd></button>{/if}
    </div>
  {/if}
  {#if sidebar}
    <div class="selection-actions">
      <span class:keyboard-hint={!selection.length}>{selection.length ? `${selection.length} selected` : 'x select'}</span>
      {#if selection.length}
        <button onclick={() => listAction('pilot')}>Shift+↵ Pilot</button>
        <button disabled={!readable.length || sourceAttention.saving} onclick={() => listAction('read')}>{sourceAttention.saving ? 'Syncing…' : 'Shift+U Mark read'}</button>
        <button onclick={() => { sidebar.listSelection = []; bulkFeedback = false; }}>Clear</button>
      {/if}
    </div>
  {/if}
 </div>
  {#if sidebar}
    {#if bulkFeedback && sourceAttention.receipt}<p class="search-status" role="status">{sourceAttention.receipt}</p>{/if}
    {#if bulkFeedback && sourceAttention.error}<p class="search-status" role="alert">{sourceAttention.error} <button onclick={() => inspectActions()}>Inspect actions</button></p>{/if}
  {/if}
  {#if chat.connectionError}<p class="search-status" role="alert">{chat.connectionError} <button class="retry" onclick={() => void refreshChats().catch(() => {})}>Retry</button></p>
  {:else if !chat.loaded}<p class="search-status" role="status">Loading Pilot sessions…</p>{/if}
 <div class="search-viewport" bind:this={viewport} onscroll={scroll} onwheel={(e) => { if (e.deltaY > 0) moreAtBottom(); }}>
  <div id="search-results" role="listbox" aria-label={recent ? "Recently added" : "Search results"} aria-busy={pending || results.loadingMore}>
    {#each hits as hit, i (hit.note.path)}
      {@const unread = readStates.get(hit.note.path)?.unread === true}
      <!-- Keep the keyboard in the combobox when selecting with the pointer. -->
      <button id={`search-hit-${i}`} class="search-hit" class:current={results.sel === i}
        class:unread class:checked={selection.includes(hit.note.path)} aria-label={unread ? `${name(hit)}, unread` : name(hit)}
        class:active-pilot={hit.dir === "pilot" && !!hit.pilotPhase && hit.pilotPhase !== "idle"}
        role="option" aria-selected={results.sel === i} aria-checked={sidebar ? selection.includes(hit.note.path) : undefined} tabindex="-1"
        onpointerdown={(e) => e.preventDefault()} onpointermove={() => floatingSearch.select(i)}
        onclick={() => onopen(i)}>
        <span class="hit-title">{#if sidebar && selection.includes(hit.note.path)}<span class="selection-check" aria-hidden="true">✓</span>{:else if hit.agentState}<AgentIndicator state={hit.agentState} size={28} />{:else}<NodeIndicator pilot={hit.dir === "pilot"} memory={hit.dir === "memory"} state={hit.pilotPhase ?? "idle"} size={28} />{/if}<span>{name(hit)}</span></span>
        <span class="hit-kind">{unread ? "Unread" : kind(hit)}</span>
        <time class="hit-date" datetime={hit.note.modified ? new Date(hit.note.modified).toISOString() : undefined}>{hit.agentState === "running" ? "Running" : hit.agentState === "waiting" ? "Needs you" : hit.agentStatus === "failed" ? "Failed" : hit.agentState === "stopped" ? "Stopped" : timestamp(hit.note.modified)}</time>
      </button>
    {/each}
  </div>
  {#if pending}
    <div class="search-status"><LoadingSpinner label={recent ? "Loading recent items" : "Searching"} /></div>
  {:else if results.failed}
    <p class="search-status" role="status">
      {results.failed === "slow" ? "Loading timed out." : recent ? "Couldn’t load recent items." : "Search failed."}
      <button class="retry" onclick={() => floatingSearch.retry()}>Retry</button>
    </p>
  {:else if !hits.length && results.nextOffset === null}
    <p class="search-status" role="status">{recent ? "No recent items." : "No results."}</p>
  {/if}
  {#if !pending && !results.failed && results.nextOffset !== null}
    <button class="search-more" class:loading={results.loadingMore} aria-label={results.moreFailed ? "Retry loading more" : "Load more"} disabled={results.loadingMore} onclick={() => floatingSearch.more()}>
      {#if results.loadingMore}<LoadingSpinner label="Loading more" />{:else}<span>{results.moreFailed ? "Couldn’t load more. Retry" : "↓"}</span>{/if}
    </button>
  {/if}
 </div>
 {#if sidebar}<BlockScrollbar {viewport} />{/if}
</div>

<style>
  .selection-actions { display:flex; align-items:center; flex-wrap:wrap; gap:12px; padding:8px 6px 12px; font:var(--type-meta); color:var(--text-muted); }
  .selection-actions button { background:none; border:0; color:inherit; cursor:pointer; padding:4px; }
  .selection-actions button:disabled { opacity:.4; cursor:default; }
  .search-hit.checked:not(.current) { background:var(--well); }
  .selection-check { width:28px; flex:none; text-align:center; }

  .search-results { position: absolute; top: calc(100% + 8px); left: 0; right: 0;
    container-type: inline-size; overflow: hidden; padding: 8px; border: 1px solid var(--rule); border-radius: 14px;
    background: var(--bg); box-shadow: 0 8px 24px color-mix(in srgb, var(--text-strong) 7%, transparent);
    animation: search-arrive 160ms cubic-bezier(.2,.8,.2,1) both; }
  .search-viewport { --search-row-height: 42px; max-height: min(calc(3 * var(--search-row-height)), 55vh);
    overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable;
    scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--text-muted) 35%, transparent) transparent; }
  .search-viewport::-webkit-scrollbar { width: 6px; }
  .search-viewport::-webkit-scrollbar-track { background: transparent; }
  .search-viewport::-webkit-scrollbar-thumb { border-radius: 6px; background: color-mix(in srgb, var(--text-muted) 35%, transparent); }
  .search-viewport::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--text-muted) 55%, transparent); }
  @supports selector(::-webkit-scrollbar) {
    .search-viewport { scrollbar-width: auto; scrollbar-color: auto; }
  }
  .search-hit { display: grid; grid-template-columns: minmax(0, 1fr) 6ch 128px; gap: 12px; align-items: center;
    height: var(--search-row-height); width: 100%; box-sizing: border-box; padding: 7px 10px;
    border: 0; border-radius: 8px; background: transparent; color: var(--text-strong); text-align: left; cursor: pointer; }
  .hit-title { display: flex; align-items: center; gap: 10px; font: 650 var(--fs-chip)/1.4 var(--font-app); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hit-title > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .search-hit.active-pilot:is(.current, :focus-visible) {
    background: var(--activity); color: var(--bg);
    --glyph-bg: var(--activity); --pilot: var(--bg);
  }
  .hit-kind, .hit-date { font: 500 11px/1.5 var(--font-mono); letter-spacing: .08em; color: var(--text-muted); white-space: nowrap; }
  .hit-kind { text-transform: uppercase; }
  .unread .hit-kind { color: inherit; font-weight: 700; }
  .hit-date { text-align: right; font-variant-numeric: tabular-nums; }
  .search-hit.current :is(.hit-kind, .hit-date), .search-hit:focus-visible :is(.hit-kind, .hit-date) { color: inherit; opacity: .75; }
  .search-status { margin: 10px 14px; color: var(--text-muted); font: var(--type-meta); }
  .search-more { display: block; height: var(--search-row-height); width: 100%; padding: 10px 14px; text-align: left;
    border: 0; border-radius: 8px; background: var(--bg); color: var(--text-muted); font: var(--type-meta); cursor: pointer; }
  .search-more:hover, .search-more:focus-visible { background: var(--well); color: var(--text-strong); }
  .search-more.loading { position: sticky; bottom: 0; display: flex; justify-content: flex-end; align-items: center; pointer-events: none;
    background: linear-gradient(transparent, var(--bg)); }
  .retry { border: 0; background: none; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }
  @container (max-width: 560px) {
    .search-hit { grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; padding-inline: 6px; }
    .hit-title { gap: 6px; font-size: 13px; }
    .hit-kind, .hit-date { font-size: 9px; letter-spacing: .02em; }
  }
  @container (max-width: 380px) {
    .search-hit { grid-template-columns: minmax(0, 1fr) auto; }
    .hit-kind { display: none; }
    .unread .hit-kind { display: block; }
    .unread .hit-date { display: none; }
  }
  @keyframes search-arrive { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) { .search-results { animation: none; } }
</style>
