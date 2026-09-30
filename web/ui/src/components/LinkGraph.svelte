<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { GraphData } from '../lib/types';
  import { graphChoreography } from '../lib/graph/choreography';
  import { GraphRenderer } from '../lib/graph/renderer';
  import { effectPreset, type EffectPreset } from '../lib/graph/effects';
  import { canonicalGraphView, changeGraphView, graphViewAction, type GraphViewState } from '../../../../lib/graphView';
  import { selectionSubgraph } from '../lib/selectionSubgraph';
  import { gotoNote } from '../lib/store.svelte';
  let { data, pilotDraft = null, selected = null, highlight = null, probe = null,
    viewState = $bindable<GraphViewState>({ selected: [], excluded: [] }), committedView,
    hoverTitle = $bindable<string | null>(null), effects = import.meta.env.DEV ? effectPreset(new URLSearchParams(location.search).get('graphEffects') ?? 'all') : 'all', embed = false, controls = false,
    coveredLeft = 0, centerFocus = false, inset = { top: 0, bottom: 0 }, onhover, onblank, onselect }: {
    data: GraphData | null; pilotDraft?: { id: string; text: string } | null;
    selected?: string | null; highlight?: string | null; probe?: string | null;
    viewState?: GraphViewState; committedView?: GraphViewState; hoverTitle?: string | null;
    effects?: EffectPreset; embed?: boolean; controls?: boolean;
    coveredLeft?: number; centerFocus?: boolean; inset?: { top: number; bottom: number };
    onhover?: (id: string | null) => void; onblank?: () => void; onselect?: (id: string | null) => void;
  } = $props();
  const subgraphExperiment = import.meta.env.DEV && new URLSearchParams(location.search).get('selectionSubgraph') === '1';
  const selectionStyle = new URLSearchParams(location.search).get('selectionStyle') === 'radial' ? 'radial' : 'cloud';
  const displayData = $derived(data && subgraphExperiment ? selectionSubgraph(data, committedView ?? viewState, committedView ? committedView.selected[0] ?? null : selected, selectionStyle) : data);
  const sidebarInspection = $derived(probe ?? (highlight !== selected ? highlight : null));
  const staged = subgraphExperiment && new URLSearchParams(location.search).get('choreography') !== 'plain';
  let departure: HTMLCanvasElement | null = null, departureFrame = 0;
  function clearDeparture() { cancelAnimationFrame(departureFrame); departure?.remove(); departure = null; }
  function fadeDepartures(nodes: ReturnType<GraphRenderer['getDepartingNodes']>) {
    clearDeparture();
    if (reduced || !nodes.length) return;
    const layer = document.createElement('canvas'); departure = layer;
    layer.setAttribute('aria-hidden', 'true');
    layer.setAttribute('data-graph-departures', '');
    Object.assign(layer.style, { position:'absolute', inset:'0', width:'100%', height:'100%', pointerEvents:'none', background:'transparent' });
    const dpr = devicePixelRatio || 1; layer.width = canvas.clientWidth * dpr; layer.height = canvas.clientHeight * dpr;
    const ctx = layer.getContext('2d')!; ctx.scale(dpr, dpr); ctx.fillStyle = ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-strong').trim();
    for (const n of nodes) {
      ctx.globalAlpha = n.alpha; ctx.beginPath();
      if (n.group === 'memory') { ctx.moveTo(n.x, n.y-n.radius); ctx.lineTo(n.x+n.radius,n.y); ctx.lineTo(n.x,n.y+n.radius); ctx.lineTo(n.x-n.radius,n.y); ctx.closePath(); ctx.stroke(); }
      else if (n.group === 'agent' || n.group === 'pilot') { ctx.moveTo(n.x-n.radius,n.y-n.radius*.6); ctx.lineTo(n.x+n.radius,n.y-n.radius*.6); ctx.lineTo(n.x,n.y+n.radius); ctx.closePath(); ctx.fill(); }
      else { ctx.arc(n.x,n.y,n.radius,0,Math.PI*2); ctx.fill(); }
    }
    canvas.parentElement!.append(layer);
    const start = performance.now();
    const fade = (now: number) => { const alpha = graphChoreography(now-start).departing; layer.style.opacity = String(alpha); if (alpha > 0) departureFrame = requestAnimationFrame(fade); else clearDeparture(); };
    departureFrame = requestAnimationFrame(fade);
  }
  let canvas = $state<HTMLCanvasElement>(null!);
  let renderer = $state.raw<GraphRenderer | null>(null);
  let hoverId = $state<string | null>(null);
  const hoverPath = $derived(displayData?.nodes.find(n => n.id === hoverId)?.selectionPath?.map(id => displayData?.nodes.find(n => n.id === id)?.title ?? id).join(' → '));
  let error = $state(''), contextRevision = $state(0), reduced = false, frame = 0;
  let dragging = $state(false);
  let gesture: { pointerId: number; id: string | null; start: { x: number; y: number }; last: { x: number; y: number } } | null = null;
  const clickSlop = 8;
  let wake: ReturnType<typeof setTimeout> | undefined;
  function kick() {
    clearTimeout(wake); wake = undefined;
    if (frame) return;
    frame = requestAnimationFrame(t => { frame = 0; if (renderer?.draw(t)) kick();
      else if (renderer?.nextWake != null) wake = setTimeout(kick, Math.max(0, renderer.nextWake - performance.now())); });
  }
  $effect(() => {
    const graph = displayData, draft = pilotDraft, preset = effects; void contextRevision;
    if (!canvas || !graph) return;
    untrack(() => {
      renderer?.setEffects(preset);
      if (renderer?.update(graph, draft)) { kick(); return; }
      // New topology rebuilds the GPU graph; it must not also reframe the
      // picture. The successor adopts the camera after its own setView.
      const departing = staged ? renderer?.getDepartingNodes(new Set(graph.nodes.map(n => n.id))) : undefined;
      const carried = renderer?.getCameraState();
      const continuous = renderer?.selectionSubgraph && !!graph.selectionRelative && selectionStyle === 'cloud' && new URLSearchParams(location.search).get('motion') !== 'independent';
      const layout = subgraphExperiment ? renderer?.getLayoutPositions() : undefined;
      cancelGesture(); cancelAnimationFrame(frame); frame = 0; renderer?.dispose(); renderer = null;
      try {
        const next = new GraphRenderer(canvas, graph, inset, coveredLeft, preset); renderer = next;
        next.selectionSubgraph = subgraphExperiment && !!graph.selectionRelative;
        next.stagedSelection = staged && next.selectionSubgraph;
        next.composedSelection = next.selectionSubgraph && selectionStyle === 'cloud' && new URLSearchParams(location.search).get('composition') !== 'plain';
        next.update(graph, draft); next.setView(viewState, selected, performance.now(), reduced, centerFocus);
        if (carried?.ready) next.adoptCamera(carried.camera, subgraphExperiment ? false : carried.manual);
        if (layout) next.animateLayoutFrom(layout, reduced, performance.now(), !!continuous);
        next.highlight([highlight, probe]);
        if (departing) fadeDepartures(departing);
        Object.assign(canvas, { profileStats: next.stats, profilePresentation: () => next.getPresentation() }); error = ''; kick();
      } catch (e) { error = String(e); }
    });
  });
  $effect(() => { renderer?.setViewport(inset, coveredLeft); kick(); });
  $effect(() => {
    const id = selected, graph = renderer, view = viewState;
    untrack(() => { cancelGesture(); hoverId = null; onhover?.(null); });
    graph?.setView(view, id, performance.now(), reduced, centerFocus); kick();
  });
  $effect(() => {
    renderer?.highlight([highlight, probe]);
    if (subgraphExperiment) {
      const inspected = sidebarInspection;
      // In a subset, both input devices inspect in place. Home previews
      // retain the original setView pan and depth treatment.
      if (displayData?.selectionRelative) renderer?.hover(inspected);
    }
    kick();
  });
  onMount(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)'); reduced = media.matches;
    const preference = () => { reduced = media.matches; renderer?.setView(viewState, selected, performance.now(), reduced, centerFocus); kick(); };
    media.addEventListener('change', preference);
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.target instanceof Element && e.target.closest('input,textarea,[contenteditable="true"]')) return;
      e.preventDefault(); clear();
    };
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', cancelGesture);
    canvas.addEventListener('wheel', wheel, { passive: false });
    // Observe the container so embedded scenes resize without a backing-canvas
    // feedback loop in WebKit.
    const resize = new ResizeObserver(kick); resize.observe(canvas.parentElement!);
    const palette = new MutationObserver(() => { renderer?.setPalette(); kick(); }); palette.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    const lost = (event: Event) => { event.preventDefault(); cancelGesture(); clearTimeout(wake); wake = undefined; cancelAnimationFrame(frame); frame = 0; error = 'Graphics context lost; waiting for restoration.'; };
    const restored = () => { renderer?.dispose(); renderer = null; contextRevision++; };
    canvas.addEventListener('webglcontextlost', lost); canvas.addEventListener('webglcontextrestored', restored);
    return () => { clearDeparture(); cancelGesture(); window.removeEventListener('keydown', escape); window.removeEventListener('blur', cancelGesture); resize.disconnect(); canvas.removeEventListener('wheel', wheel); palette.disconnect(); media.removeEventListener('change', preference); canvas.removeEventListener('webglcontextlost', lost); canvas.removeEventListener('webglcontextrestored', restored); clearTimeout(wake); cancelAnimationFrame(frame); renderer?.dispose(); };
  });
  function local(event: MouseEvent) {
    const box = canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top };
  }
  function hit(event: MouseEvent) {
    const { x, y } = local(event);
    return renderer?.pick(x, y) ?? null;
  }
  function clearHover() { hoverTitle = null; hoverId = null; renderer?.hover(subgraphExperiment && displayData?.selectionRelative ? sidebarInspection : null); onhover?.(null); kick(); }
  function move(event: PointerEvent) {
    if (gesture) {
      if (event.pointerId !== gesture.pointerId) return;
      const p = local(event), starting = !dragging;
      if (starting && Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) < clickSlop) return;
      if (starting && gesture.id) renderer?.beginNodeDrag(gesture.id, gesture.start);
      dragging = true;
      if (gesture.id) renderer?.dragNode(p);
      else {
        const last = starting ? gesture.start : gesture.last;
        renderer?.pan({ x: p.x - last.x, y: p.y - last.y });
      }
      gesture.last = p; kick(); return;
    }
    const id = hit(event);
    if (id === hoverId) return;
    hoverId = id; hoverTitle = data?.nodes.find(n => n.id === id)?.title ?? null;
    renderer?.hover(id, performance.now(), subgraphExperiment); if (!subgraphExperiment || !displayData?.selectionRelative) onhover?.(id); kick();
  }
  function down(event: PointerEvent) {
    if (event.button !== 0 || event.ctrlKey || gesture) return;
    event.preventDefault();
    const p = local(event);
    gesture = { pointerId: event.pointerId, id: hit(event), start: p, last: p }; dragging = false;
    canvas.setPointerCapture(event.pointerId);
  }
  function up(event: PointerEvent) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    move(event);
    const { id } = gesture, moved = dragging;
    cancelGesture();
    if (moved) return;
    clearHover();
    if (id) {
      const action = graphViewAction(id, event);
      viewState = changeGraphView(committedView ?? viewState, action);
      // A click is deliberate navigation, so it recentres even on the current
      // view; the effect above re-applies centerFocus for the settled state.
      renderer?.setView(viewState, action.type === 'select' ? id : selected, performance.now(), reduced, false, 'navigate');
      if (action.type === 'select') { if (onselect) onselect(id); else gotoNote(id); }
    } else clear();
    kick();
  }
  function cancelGesture() {
    if (!gesture) return;
    const { pointerId } = gesture;
    gesture = null; dragging = false; renderer?.endNodeDrag();
    if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    kick();
  }
  function wheel(event: WheelEvent) {
    if (embed && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (gesture) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
    const delta = Math.max(-1000, Math.min(1000, event.deltaY * unit));
    renderer?.zoomAt(local(event), Math.exp(-delta * .0015)); kick();
  }
  function refit(event: MouseEvent) {
    const p = local(event);
    if (renderer?.pick(p.x, p.y)) return;
    clear();
  }
  // macOS Ctrl-click may arrive only as mousedown, so exclusions use the
  // compatibility event instead of depending on pointerdown.
  function exclude(event: MouseEvent) {
    if (!event.ctrlKey || ![0, 2].includes(event.button)) return;
    event.preventDefault(); const id = hit(event); if (!id) return;
    viewState = changeGraphView(committedView ?? viewState, { type: 'exclude', id });
    clearHover(); renderer?.setView(viewState, selected, performance.now(), reduced); kick();
  }
  function clear() { viewState = { selected: [], excluded: [] }; resetOverview(); onblank?.(); onselect?.(null); }
  export function getViewState() { return data ? canonicalGraphView(data.nodes, viewState) : viewState; }
  export function getPresentation() { return renderer?.getPresentation(); }
  export function getCamera() {
    const p = renderer?.getCamera();
    return p ? { scale: p.zoom, tx: canvas.clientWidth / 2 - p.x * p.zoom, ty: canvas.clientHeight / 2 - p.y * p.zoom } : null;
  }
  export function resetOverview() { cancelGesture(); clearHover(); renderer?.refit(); kick(); }
  export function getStats() { return renderer?.stats; }
</script>
<div class="lg-wrap graph-renderer" data-renderer="webgl" data-selected={selected ?? ''} data-hovered={hoverId ?? ''}>
  <canvas bind:this={canvas} onmousedown={exclude} oncontextmenu={e => { if (e.ctrlKey) e.preventDefault(); }} onpointerdown={down} onpointerup={up} onpointermove={move} onpointercancel={cancelGesture} onlostpointercapture={cancelGesture} ondblclick={refit} onpointerleave={() => { if (!gesture) clearHover(); }} style:cursor={dragging ? 'grabbing' : hoverId ? 'pointer' : 'grab'} aria-label="Knowledge graph"></canvas>
  {#if controls}<div class="graph-controls"><button onclick={clear}>Reset view</button><span>Shift-click to add · Ctrl-click to exclude</span></div>{/if}
  {#if subgraphExperiment && hoverPath}<aside class="selection-path" role="status">{hoverPath}</aside>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
</div>
<style>
  .selection-path { position:fixed; bottom:32px; right:20px; max-width:min(480px,45vw); padding:8px 12px; background:var(--bg); color:var(--text); border:1px solid var(--rule); font:var(--type-meta); pointer-events:none; }
  .lg-wrap { position:absolute; inset:0; }
  canvas { display:block; width:100%; height:100%; background:var(--bg); touch-action:none; }
  .graph-controls { position:absolute; bottom:12px; left:12px; display:flex; gap:12px; align-items:center; background:var(--bg); }
  p { position:absolute; top:60px; right:20px; background:var(--bg); color:var(--text); padding:16px; }
</style>
