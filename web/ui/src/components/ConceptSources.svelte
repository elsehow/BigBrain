<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../lib/api";
  import { readBriefing } from "../lib/noteBriefing";
  import { app } from "../lib/store.svelte";
  import type { BriefingScope } from "../../../../lib/noteBriefing";
  import { sourcesNewestFirst, type EntitySource } from "../../../../lib/views/entitySources";

  let { entity, title, scope, onread }: { entity: string; title: string; scope?: BriefingScope; onread: (source: EntitySource) => void } = $props();
  let sources: EntitySource[] = $state([]);
  let loading = $state(true), error = $state(false), retry = $state(0), count = $state(8);
  let summaries: Record<string, { text: string; done: boolean; failed?: boolean }> = $state({});
  const visible = $derived(sources.slice(0, count));
  $effect(() => {
    const id = entity, selected = scope;
    void retry; void app.views?.views.feed; void app.views?.views.joined;
    const controller = new AbortController();
    loading = true; error = false; sources = []; summaries = {}; count = 8;
    void api.entitySources(id, selected, controller.signal).then(result => {
      if (!controller.signal.aborted) sources = result.sources.sort(sourcesNewestFirst);
    }).catch(() => { if (!controller.signal.aborted) error = true; })
      .finally(() => { if (!controller.signal.aborted) loading = false; });
    return () => controller.abort();
  });
  $effect(() => {
    const rows = visible, selected = scope;
    const controller = new AbortController();
    let next = 0;
    // Bound model work to the displayed page, with two requests in flight.
    // Leaving the concept stops queued work; the engine retains finished memos.
    async function worker(): Promise<void> {
      while (!controller.signal.aborted && next < rows.length) {
        const source = rows[next++]!;
        if (untrack(() => summaries[source.path]?.done)) continue;
        const ok = await readBriefing(source.path, text => {
          if (!controller.signal.aborted) summaries[source.path] = { text, done: false };
        }, selected, controller.signal);
        if (!controller.signal.aborted) summaries[source.path] = {
          text: ok ? (summaries[source.path]?.text ?? "") : "", done: true, failed: !ok,
        };
      }
    }
    void worker(); void worker();
    return () => controller.abort();
  });
  function added(at: string): string {
    const date = new Date(at);
    return Number.isFinite(date.getTime()) ? `Added ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : "";
  }
</script>

<section class="concept-sources" aria-label={`Sources for ${title}`} aria-busy={loading}>
  <h2>Sources {#if sources.length}<span>{sources.length}</span>{/if}</h2>
  {#if loading}<p class="status">Loading sources…</p>
  {:else if error}<p class="status">Couldn’t load sources. <button class="retry" onclick={() => retry++}>Retry</button></p>
  {:else if !sources.length}<p class="status">No linked sources yet.</p>
  {:else}
    <div class="source-list">
      {#each visible as source (source.path)}
        {@const summary = summaries[source.path]}
        <button class="source" type="button" onclick={() => onread(source)} aria-label={`Read ${source.title}`}>
          <span class="source-title">{source.title}<span aria-hidden="true">↗</span></span>
          <span class="source-meta">{[source.via, added(source.added)].filter(Boolean).join(" · ")}</span>
          <span class="source-summary">{summary?.text || (summary?.failed ? "Summary unavailable" : "Writing a summary…")}</span>
        </button>
      {/each}
      {#if sources.length > count}<button class="more" onclick={() => count += 8}>Show more sources</button>{/if}
    </div>
  {/if}
</section>

<style>
  .concept-sources { pointer-events:auto; margin-top:16px; max-width:390px; padding:0 12px 0 0; background:var(--bg); text-shadow:none; }
  h2 { margin:0 0 4px; font:500 14px/1.4 var(--font-app); }
  h2 > span { margin-left:6px; font:400 11px/1 var(--font-mono); color:var(--v2-muted); }
  .source-list { max-height:50vh; overflow:auto; overscroll-behavior:contain; }
  button { color:var(--fg); font:inherit; cursor:pointer; }
  .source { display:flex; flex-direction:column; gap:5px; width:100%; padding:15px 0; border:0; border-bottom:1px solid var(--rule); background:transparent; text-align:left; }
  .source:hover .source-title { text-decoration:underline; text-underline-offset:3px; }
  .source-title { display:flex; justify-content:space-between; gap:12px; width:100%; font:500 14px/1.4 var(--font-app); }
  .source-title > span { color:var(--v2-muted); }
  .source-meta { font:400 11px/1.4 var(--font-mono); color:var(--v2-muted); }
  .source-summary, .status { margin:3px 0 0; font:400 13px/1.5 var(--font-app); color:var(--v2-muted); }
  .more, .retry { padding:8px 0; border:0; background:transparent; font:400 13px/1.5 var(--font-app); text-decoration:underline; }
</style>
