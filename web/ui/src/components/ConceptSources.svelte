<script lang="ts">
  import { api } from "../lib/api";
  import ConceptSource from "./ConceptSource.svelte";
  import { app } from "../lib/store.svelte";
  import type { BriefingScope } from "../../../../lib/noteBriefing";
  import { sourcesNewestFirst, type EntitySource } from "../../../../lib/views/entitySources";

  let { entity, title, scope, onread }: { entity: string; title: string; scope?: BriefingScope; onread: (source: EntitySource) => void } = $props();
  let sources: EntitySource[] = $state([]);
  let loading = $state(true), error = $state(false), retry = $state(0), count = $state(8);
  const visible = $derived(sources.slice(0, count));
  $effect(() => {
    const id = entity, selected = scope;
    void retry; void app.views?.views.feed; void app.views?.views.joined;
    const controller = new AbortController();
    loading = true; error = false; sources = []; count = 8;
    void api.entitySources(id, selected, controller.signal).then(result => {
      if (!controller.signal.aborted) sources = result.sources.sort(sourcesNewestFirst);
    }).catch(() => { if (!controller.signal.aborted) error = true; })
      .finally(() => { if (!controller.signal.aborted) loading = false; });
    return () => controller.abort();
  });
</script>

<section class="concept-sources" aria-label={`Sources for ${title}`} aria-busy={loading}>
  <h2>Sources {#if sources.length}<span>{sources.length}</span>{/if}</h2>
  {#if loading}<p class="status">Loading sources…</p>
  {:else if error}<p class="status">Couldn’t load sources. <button class="retry" onclick={() => retry++}>Retry</button></p>
  {:else if !sources.length}<p class="status">No linked sources yet.</p>
  {:else}
    <div class="source-list">
      {#each visible as source (source.path)}
        <ConceptSource {source} {scope} {onread} />
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
  .status { margin:3px 0 0; font:400 13px/1.5 var(--font-app); color:var(--v2-muted); }
  .more, .retry { padding:8px 0; border:0; background:transparent; font:400 13px/1.5 var(--font-app); text-decoration:underline; }
</style>
