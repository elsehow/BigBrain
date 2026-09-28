<script lang="ts">
  import { getContext } from "svelte";
  import { SIDEBAR_LAYOUT, type SidebarLayout } from "../lib/sidebarLayout";
  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);
  // The complete graph behind the text pane.
  import LinkGraph from "./LinkGraph.svelte";
  import type { GraphData } from "../lib/types";
  import { canonicalGraphView, changeGraphView } from "../../../../lib/graphView";
  import { findNode } from "../../../../lib/graphIdentity";
  import { stage } from "../lib/stage.svelte";
  import { app } from "../lib/store.svelte";
  import { uiDiagnostics } from "../lib/uiDiagnostics";

  const { data, pilotViewId = null, pilotDraft = null, highlight = null, selected = null, preview = null, probe = null, inset = { top: 0, bottom: 0 }, onselect }: {
    onselect?: (id: string | null) => void;
    data: GraphData | null;
    /** Parent Pilot owns the graph view while any of its conversations is open. */
    pilotViewId?: string | null;
    pilotDraft?: { id: string; text: string } | null;
    /** the feed's selected row, lit in the graph as a hover would — LinkGraph */
    highlight?: string | null;
    /** The open note, whose direct connections the camera frames. */
    selected?: string | null;
    /** Search previews the neighborhood without changing the committed selection. */
    preview?: string | null;
    /** the link the keyboard is on in the open note, lit as a hover would — LinkGraph */
    probe?: string | null;
    /** the room the picture fits into, off the window's top and bottom (LinkGraph) */
    inset?: { top: number; bottom: number };
  } = $props();

  let viewportWidth = $state(window.innerWidth);
  let renderer = $state<LinkGraph>();
  $effect(() => { if (sidebar) { sidebar.resetGraph = () => renderer?.resetOverview(); sidebar.camera = () => renderer?.getCamera() ?? null; sidebar.presentation = () => renderer?.getPresentation(); } });

  const pilotView = $derived(pilotViewId ? { selected: [pilotViewId], excluded: [] } : null);
  const agentOverview = $derived(!!sidebar?.open && !!sidebar?.agents);
  const effectivePreview = $derived((!sidebar?.open ? sidebar?.homePreview : null) ?? (agentOverview ? stage.pilotPreviewId : preview));
  const previewView = $derived(effectivePreview && data ? canonicalGraphView(data.nodes,
    { selected: findNode(data.nodes, effectivePreview) >= 0 ? [effectivePreview] : [], excluded: [] }) : null);
</script>

<svelte:window bind:innerWidth={viewportWidth} />

{#if data?.nodes.length && !uiDiagnostics?.graphOff}
  <div class="g-block">
    <div class="g-canvas">
      <LinkGraph bind:this={renderer} {data} {inset} {pilotDraft} committedView={app.graphView}
        coveredLeft={sidebar?.open && !sidebar.fullscreenChat ? Math.min(560, viewportWidth) : sidebar?.homeMenuRight ?? 0}
        centerFocus={!!sidebar?.homePreview}
        selected={effectivePreview ?? pilotViewId ?? (agentOverview ? null : selected)}
        highlight={sidebar?.homePreview ?? (agentOverview ? stage.pilotPreviewId : highlight)} probe={agentOverview ? null : probe}
        bind:viewState={() => previewView ?? (agentOverview ? { selected: [], excluded: app.graphView.excluded } : pilotView ?? app.graphView), value => { if (!effectivePreview) app.graphView = value; }}
        onhover={id => { if (sidebar) sidebar.hoverId = id; }}
        onblank={() => { app.graphView = changeGraphView(app.graphView, { type: 'clear' }); sidebar?.goHome?.(); }}
        {onselect} />

    </div>
  </div>
{/if}

<style>
  /* The fixed graph sits behind the text pane in its stacking context. */
  .g-block { position: relative; display: flex; align-items: flex-start;
    margin: var(--sp-6) 0; pointer-events: none; }
  .g-canvas { position: fixed; inset: 0; z-index: -1; pointer-events: auto; }
</style>
