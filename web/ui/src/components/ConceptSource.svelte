<script lang="ts">
  import { readBriefing } from "../lib/noteBriefing";
  import type { BriefingScope } from "../../../../lib/noteBriefing";
  import type { EntitySource } from "../../../../lib/views/entitySources";

  let { source, scope, onread }: { source: EntitySource; scope?: BriefingScope; onread: (source: EntitySource) => void } = $props();
  let row: HTMLButtonElement | undefined = $state();
  let text = $state(""), failed = $state(false), pending = $state(false);
  $effect(() => {
    const target = row, path = source.path, selected = scope;
    if (!target) return;
    text = ""; failed = false; pending = false;
    let controller: AbortController | undefined, done = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) {
        controller?.abort(); controller = undefined; pending = false;
        return;
      }
      if (done || controller) return;
      const request = controller = new AbortController();
      pending = true;
      void readBriefing(path, value => { if (!request.signal.aborted) text = value; }, selected, request.signal, "source").then(ok => {
        if (request.signal.aborted) return;
        done = true; pending = false; failed = !ok;
        if (!ok) text = "";
      });
    }, { root: target.parentElement, rootMargin: "120px 0px" });
    observer.observe(target);
    return () => { observer.disconnect(); controller?.abort(); };
  });
  function added(at: string): string {
    const date = new Date(at);
    return Number.isFinite(date.getTime()) ? `Added ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : "";
  }
</script>

<button bind:this={row} class="source" type="button" onclick={() => onread(source)} aria-label={`Read ${source.title}`}>
  <span class="source-title">{source.title}<span aria-hidden="true">↗</span></span>
  <span class="source-meta">{[source.via, added(source.added)].filter(Boolean).join(" · ")}</span>
  <span class="source-summary">{text || (failed ? "Summary unavailable" : pending ? "Writing a summary…" : "\u00a0")}</span>
</button>

<style>
  .source { display:flex; flex-direction:column; gap:5px; width:100%; padding:15px 0; border:0; border-bottom:1px solid var(--rule); background:transparent; text-align:left; color:var(--fg); font:inherit; cursor:pointer; }
  .source:hover .source-title { text-decoration:underline; text-underline-offset:3px; }
  .source-title { display:flex; justify-content:space-between; gap:12px; width:100%; font:500 14px/1.4 var(--font-app); }
  .source-title > span { color:var(--v2-muted); }
  .source-meta { font:400 11px/1.4 var(--font-mono); color:var(--v2-muted); }
  .source-summary { margin:3px 0 0; min-height:1.5em; font:400 13px/1.5 var(--font-app); color:var(--v2-muted); }
</style>
