<script lang="ts">
  import { personalIncluded } from "../lib/vaultScope";
  import PilotQuickLook from "./PilotQuickLook.svelte";
  import WorkspaceMenu from "./WorkspaceMenu.svelte";
  import { getContext, onMount, untrack, tick } from "svelte";
  import { mentionText, parseMentions } from "../../../../lib/pilotMentions";
  import { findNode } from "../../../../lib/graphIdentity";
  import { canonicalGraphView } from "../../../../lib/graphView";
  import { SIDEBAR_LAYOUT, type SidebarLayout } from "../lib/sidebarLayout";
  import { withAgentHistory } from "../lib/agentSessionGraph";
  import { work } from "../lib/workSessions.svelte";
  import WorkSessionPanel from "./WorkSessionPanel.svelte";
  import Pilot from "./Pilot.svelte";
  import { activeChat, chat, chatSessions, loadChatDetail, openChat, startChat, leaveChat, stopChat } from "../lib/pilotChat.svelte";
  import { preparePilotChats } from "../lib/pilotChatGraph";
  import PilotChatPanel from "./PilotChatPanel.svelte";
  import { isSettingsView } from "../lib/settingsViews";
  import { editable, isMac } from "../lib/dom";
  import { searchOverlay } from "../lib/omnibox.svelte";
  import { floatingResults as results } from "../lib/floatingSearch.svelte";
  import HomeFolds from "./HomeFolds.svelte";
  import EmptyVault from "./EmptyVault.svelte";
  import NoteTab from "./NoteTab.svelte";
  import SystemGraph from "./SystemGraph.svelte";
  import { withSourceReadStates } from "../lib/sourceReadGraph";
  import { sourceAttention, isUnreadSelection } from "../lib/sourceAttention.svelte";
  import { arrivals, reconcileArrivals } from "../lib/arrivals.svelte";
  import { withArrivals } from "../lib/arrivalGraph";
  import { swr } from "../lib/api";
  import { app, gotoNote, showGraphSelection, showPilotSelection } from "../lib/store.svelte";
  import { chromeUp, hold, release, stage } from "../lib/stage.svelte";
  import { liveResource } from "../lib/liveResource.svelte";
  import type { GraphData } from "../lib/types";
  let { identity = null }: { identity?: { name: string; entity_id: string } | null } = $props();

  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);
  // The graph stays visible; the bottom panel describes only its selection.
  // Search results float below the omnibox without changing that selection.
  const noteOpen = $derived(!!app.activeNote);

  // Graph responses are replaced as snapshots; deep proxies make every
  // graph traversal pay reactive lookup costs without enabling useful updates.
  let graph = $state.raw<GraphData | null>(null);
  let graphError = $state('');
  liveResource(() => "graph", () => swr.graph(), g => {
    graph = g; graphError = '';
    reconcileArrivals(g);
  }, {onError: (error) => {graphError = error instanceof Error ? error.message : 'Could not load this vault.';}});

  // Session activity belongs to the same sources as the rest of the vault.
  // Wait for the cached vault graph before adding sessions. On a remount,
  // a session-only graph would evict the expensive full overview layout.
  const session = $derived(activeChat());
  const sessionId = $derived(session?.id);
  const selectedWork = $derived(work.sessions.find(s => app.activeNote === `sessions/${s.id}.md`));
  const viewSession = $derived(session ?? chatSessions().find(s => s.id === selectedWork?.origin?.pilot));
  $effect(() => { if (sourceAttention.selection && !isUnreadSelection()) sourceAttention.selection = ""; });
  const arrivalGraph = $derived(withArrivals(graph, arrivals.nodes));
  // Nothing has landed yet: at most the gardener's memory notes, no arrival on its way.
  const vaultEmpty = $derived(!!arrivalGraph && arrivalGraph.nodes.every(n => n.group === "memory" && !n.pending));
  const readGraph = $derived(withSourceReadStates(arrivalGraph, sourceAttention.rows));
  const pilotGraph = $derived(preparePilotChats(readGraph, personalIncluded ? chatSessions() : []));
  const visibleGraph = $derived(withAgentHistory(readGraph ? pilotGraph(sidebar ? null : viewSession?.id ?? null) : null, personalIncluded ? work.sessions : []));
  const overviewRoot = $derived(visibleGraph?.nodes.find(n => n.group === "memory" && /(^|\/)MEMORY\.md$/.test(n.path ?? n.id)));
  const studyGraph = $derived.by(() => {
    if (!visibleGraph || !sidebar || !overviewRoot) return visibleGraph;
    if (app.activeNote === overviewRoot.path) return visibleGraph;
    return { ...visibleGraph, nodes: visibleGraph.nodes.filter(n => n.id !== overviewRoot.id), edges: visibleGraph.edges.filter(e => e.source !== overviewRoot.id && e.target !== overviewRoot.id) };
  });
  $effect(() => { stage.sessionOpen = chat.open && !!session; return () => { stage.sessionOpen = false; }; });
  let chatPanel = $state<PilotChatPanel>();
  let workPanel = $state<WorkSessionPanel>();
  let expanded = $state(false);
  let resizing = false;
  let animatingHeight = $state(false);
  let resizeRevision = 0;
  let heightAnimation: Animation | undefined;
  async function resizePilot(next: boolean): Promise<void> {
    if (sidebar) { sidebar.expanded = next; return; }
    if (!drawerEl || expanded === next) return;
    const from = drawerEl.getBoundingClientRect().height;
    const panel = chat.open ? chatPanel : workPanel;
    const collapseScroll = next ? undefined : panel?.beginCollapse();
    heightAnimation?.cancel(); resizing = true; animatingHeight = false;
    const revision = ++resizeRevision; expanded = next;
    await tick();
    if (!drawerEl || revision !== resizeRevision) return;
    if (viewportWidth < 1050 && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const to = drawerEl.getBoundingClientRect().height;
      // Animate max-height too: the contracted CSS limit must not clip the
      // expanded starting frame. Keep the transcript flexible until settled.
      const animation = heightAnimation = drawerEl.animate([
        { height: `${from}px`, maxHeight: `${from}px` },
        { height: `${to}px`, maxHeight: `${to}px` },
      ], { duration: 260, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "both" });
      animatingHeight = true;
      let frame = 0;
      const scroll = () => {
        if (revision !== resizeRevision) return;
        collapseScroll?.(Number(animation.effect?.getComputedTiming().progress ?? 0));
        frame = requestAnimationFrame(scroll);
      };
      if (collapseScroll) frame = requestAnimationFrame(scroll);
      try { await animation.finished; } catch { /* Reversed or closed. */ }
      cancelAnimationFrame(frame);
      if (revision !== resizeRevision) return;
      collapseScroll?.(1);
      animatingHeight = false;
      await tick();
      animation.cancel();
    }
    if (revision === resizeRevision) {
      resizing = false;
      if (!expanded && drawerEl) { drawerH = drawerEl.getBoundingClientRect().height; panel?.scrollToBottom(); }
    }
  }
  $effect(() => { if (sidebar) expanded = sidebar.expanded; });
  $effect(() => {
    void sessionId; void selectedWork?.id;
    if (sidebar) sidebar.expanded = false;
    untrack(() => { heightAnimation?.cancel(); resizeRevision++; resizing = false; animatingHeight = false; expanded = false; });
  });
  $effect(() => { chat.graph = graph; });
  $effect(() => {
    const next = chat.sessions.find(s => app.graphView.selected.includes(s.id));
    untrack(() => {
      if ((next?.id ?? null) === chat.activeId) return;
      if (chat.activeId) void leaveChat();
      if (next) void loadChatDetail(next.id).catch(() => {});
      chat.activeId = next?.id ?? null; chat.open = !!next; if (next && app.pilotAutofocus) chat.focus++;
    });
  });
  const memories = $derived((visibleGraph?.nodes ?? []).filter(n => n.group === "memory" && n.path && n.id !== overviewRoot?.id)
          .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)));

  onMount(() => {
    const key = (e: KeyboardEvent) => {
      // Stop remains available while typing, including inside the composer.
      if (!e.defaultPrevented && !e.isComposing && e.key === "." && !e.altKey && !e.shiftKey
        && (isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)
        && chat.open && activeChat()?.phase === "working") {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat) void stopChat();
        return;
      }
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (sidebar?.memoryPreview && e.key === "Enter" && !e.shiftKey && !editable(e.target)) {
        e.preventDefault(); e.stopImmediatePropagation();
        sidebar.memoryPreview = null; sidebar.open = true;
        return;
      }
      if (searchOverlay.open || stage.pilotsOpen) return; // The search dropdown owns its Escape.
      if ((!sidebar || sidebar.open) && chat.open && !(sidebar && e.shiftKey && ["ArrowUp", "ArrowDown"].includes(e.key)) && chatPanel?.handleKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.key === "Escape" && chat.open) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) { if (e.shiftKey) chatPanel?.shiftEscape(); else chatPanel?.escape(); } }
      else if (e.key === "Enter" && e.shiftKey && !editable(e.target) && !activeChat()) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) void startChat(); }
    };
    window.addEventListener("keydown", key, true);
    return () => { heightAnimation?.cancel(); window.removeEventListener("keydown", key, true); };
  });
  $effect(() => {
    if (!visibleGraph || isSettingsView(app.view)) return;
    // A history/deep-link target may arrive before the initial session poll.
    if (app.routePilot && !chat.loaded && !chat.sessions.some(s => s.id === app.routePilot)) return;
    if (app.activeNote?.startsWith("sessions/work-") && (!work.loaded || !chat.loaded)) return;
    const state = canonicalGraphView(visibleGraph.nodes, app.graphView);
    untrack(() => {
      if (JSON.stringify(state) !== JSON.stringify(app.graphView)) app.graphView = state;
      const nodes = state.selected.flatMap(id => visibleGraph.nodes.filter(n => n.id === id));
      const current = visibleGraph.nodes[findNode(visibleGraph.nodes, app.activeNote ?? "")];
      const remaining = nodes.find(n => n.id === current?.id) ?? nodes.find(n => n.path);
      const pilotNode = nodes.find(n => chat.sessions.some(s => s.id === n.id));
      if (pilotNode) showPilotSelection(pilotNode.id);
      else if (remaining?.path) showGraphSelection(remaining.path);
      else if (!state.selected.length && (app.activeNote || app.routePilot)) showGraphSelection(null);
    });
  });
  $effect(() => { work.selectedTitle = visibleGraph?.nodes.find(n => n.id === app.activeNote || (n.path === app.activeNote || !!n.sourcePaths?.includes(app.activeNote ?? "")))?.title ?? ""; });
  $effect(() => { work.graph = visibleGraph; });


  const searchHit = $derived(searchOverlay.open && !results.building && !results.failed && results.query === app.query.trim()
    ? results.hits[results.sel]?.note.path ?? null : null);
  const hoverNode = $derived(visibleGraph?.nodes[findNode(visibleGraph.nodes, sidebar?.hoverId ?? "")]);
  const noteHover = $derived(sidebar?.homePreview ?? (hoverNode?.pilotPhase || hoverNode?.group === "pilot" ? null : sidebar?.hoverId));
  const previewAgent = $derived(noteHover ? chatSessions().find(s => s.id === noteHover) : undefined);
  let probe = $state<string | null>(null);

  // ── the stage (lib/stage.svelte.ts): what brings the chrome up ────────
  // Pointer proximity reveals the top bar; selected notes keep their panel up.
  const EDGE = 28;
  let drawerEl = $state<HTMLDivElement | null>(null);
  let previewEl = $state<HTMLDivElement | null>(null), previewH = $state(0);
  $effect(() => {
    if (!previewEl) { previewH = 0; return; }
    const observer = new ResizeObserver(([entry]) => { previewH = entry?.borderBoxSize[0]?.blockSize ?? entry?.contentRect.height ?? 0; });
    observer.observe(previewEl); return () => observer.disconnect();
  });
  const within = (el: Element | null, e: PointerEvent): boolean => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  function edges(e: PointerEvent): void {
    const y = e.clientY;
    // The update banner shifts the bar down; use its actual bounds so the
    // lower part of the search field keeps the chrome visible.
    const top = y < EDGE || within(document.querySelector(".nudge"), e)
      || (chromeUp() && within(document.querySelector("#topbar"), e));
    const bottom = y > window.innerHeight - EDGE || within(drawerEl, e);
    stage.peek = top || bottom;
  }
  function ground(e: PointerEvent): void {
    const t = e.target as Element;
    if (drawerEl?.contains(t)) hold();
    else if (t.tagName === "CANVAS") { release(); }
  }
  const drawerUp = $derived(chat.open && !!session || noteOpen);
  // Fit the graph into the space left by a selected note's fixed-height panel.
  let drawerH = $state(0), viewportHeight = $state(window.innerHeight), viewportWidth = $state(window.innerWidth);
  const sideExpanded = $derived(!sidebar && viewportWidth >= 1050 && expanded && (chat.open || !!selectedWork));
  $effect(() => {
    if (!drawerEl) return;
    const ro = new ResizeObserver(([entry]) => { if (!((chat.open || selectedWork) && (expanded || resizing))) drawerH = entry?.contentRect.height ?? 0; });
    ro.observe(drawerEl);
    return () => ro.disconnect();
  });
  const pinned = $derived(drawerUp);
  // A Pilot and its agents share the same camera room even when their text
  // panels have different content heights. Match the standard agent drawer.
  const graphDrawerH = $derived(viewSession ? Math.min(viewportHeight * .42, 430) : drawerH);
  const inset = $derived(sidebar ? sidebar.homePreview ? { top: 80, bottom: previewH + 64 } : sidebar.memoryPreview ? { top: 80, bottom: 24 } : { top: 0, bottom: 0 } : pinned ? { top: 92, bottom: sideExpanded ? 12 : graphDrawerH + 12 } : { top: 0, bottom: 0 });
  // arriving here, the chrome is down: what was held on a previous visit
  // is not held now
  $effect(() => { release(); stage.peek = false; });
</script>

<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} onpointermove={edges} onpointerdown={ground} />

{#if sidebar && !sidebar.open && !chat.open}
  <WorkspaceMenu memories={memories} sources={(visibleGraph?.nodes??[]).filter(n=>n.group==='source'&&n.path)} loading={!graph&&!graphError} {sidebar} />
{/if}

<section class="view">
  {#if !graph && graphError}<div class="graph-error" role="alert">{graphError} <button onclick={()=>{graphError='';app.rev++;}}>Retry</button></div>{/if}
  <div class="pane" class:side-expanded={sideExpanded}>
    <!-- the memory pass's fold proposals (#728), above everything (Nick,
         2026-09-03) so they get triaged: labels that look like one thing,
         settled with a click each way. Renders nothing when nothing is
         proposed. -->
    <HomeFolds />

    <!-- what the vault IS: the ground of this screen -->
    <SystemGraph pilotViewId={viewSession?.id ?? null} pilotDraft={session ? { id: session.id, text: mentionText(parseMentions(chat.drafts[session.id] ?? session.draft)) } : null} data={studyGraph} highlight={stage.pilotPreviewId ?? searchHit ?? session?.id ?? app.activeNote} selected={session?.id ?? app.activeNote} preview={searchHit} probe={searchHit ?? probe} {inset}
      onselect={id => {
        if (!id) return;
        if (chat.sessions.some(s => s.id === id)) openChat(id);
        else { const node = visibleGraph?.nodes.find(n => n.id === id); if (node?.path) gotoNote(node.path); }
      }} />
    {#if vaultEmpty && !drawerUp && !sidebar?.open}<EmptyVault />{/if}
    {#if viewSession}<div class="pilot-view"><strong>Pilot view</strong><span>{viewSession.title}</span></div>{/if}
    {#if chat.error && !chat.open}<p class="pilot-error" role="alert">{chat.error}</p>{/if}
    {#if chat.toast}<div class="pilot-toast" role="alert">{chat.toast}<button aria-label="Dismiss Pilot error" onclick={() => chat.toast = ""}>×</button></div>{/if}

    {#if sidebar && noteHover && !sidebar.expanded && !(sidebar.open && noteHover === app.activeNote)}
      <div class="sidebar-quick drawer up" class:agent-quick={!!previewAgent} bind:this={previewEl} role="region" aria-label="Quick look">
        <div class="sheet">
          {#if previewAgent}<PilotQuickLook id={previewAgent.id} graph={visibleGraph} />
          {:else}<NoteTab graph={visibleGraph} {identity} previewPath={noteHover} />{/if}

        </div>
      </div>
    {/if}
    {#if drawerUp && !sidebar?.memoryPreview}
    <div class="drawer up" inert={sidebar ? !sidebar.open : undefined} class:chat-drawer={chat.open} class:agent-drawer={!!selectedWork && !chat.open} class:expanded={(chat.open || !!selectedWork) && expanded} class:empty-chat={chat.open && !session?.messages?.length} bind:this={drawerEl} role="region" aria-label={chat.open ? "Pilot text tab" : selectedWork ? "Agent text tab" : "Selected notes"}>
      <div class="sheet">
        {#if chat.open && session}
          <PilotChatPanel bind:this={chatPanel} expanded={!!sidebar || expanded} resizable={!sidebar} resizing={animatingHeight} onresize={resizePilot} />
        {:else if selectedWork}
          {#key selectedWork.id}<WorkSessionPanel bind:this={workPanel} id={selectedWork.id} {expanded} onresize={resizePilot} />{/key}
        {:else if noteOpen}
          {#key app.activeNote}
            <NoteTab graph={visibleGraph} {identity} bind:probe />
          {/key}
        {/if}
      </div>
    </div>
    {/if}
  </div>
</section>
<Pilot />

<style>
  .graph-error{position:absolute;top:90px;left:32px;z-index:5;color:var(--text-muted);font:var(--type-meta)}
  /* the app's one frame — see app.css's --app-pad-*: every view pads with
     these two numbers, so no screen invents its own margin */
  /* The column holds the rail (and fold proposals, when there are any).
     The graph is the GROUND of this screen: its canvas is fixed to the
     window at z -1 (SystemGraph), and isolating the pane keeps that -1
     inside it — above the app's background, under everything here. */
  .pane { flex: 1; min-height: 0; overflow-y: auto;
    padding: 0 var(--app-pad-right) 34px var(--app-pad-left); isolation: isolate; }
  /* Stable height reserves the same graph room as content and selection change. */
  .drawer { position: fixed; left: 50%; bottom: 12px; z-index: 2; display: flex;
    width: min(calc(100vw - 2 * var(--app-gutter)), var(--app-max));
    height: min(30vh, 280px); transform: translateX(-50%);
    animation: hud-arrive 180ms cubic-bezier(.2,.8,.2,1) both; }
  .sheet { container-type: inline-size; display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; overflow: hidden;
    border-radius: 14px; background: var(--panel-bg); backdrop-filter: var(--panel-blur); -webkit-backdrop-filter: var(--panel-blur); border: 1px solid var(--rule);
    box-shadow: 0 8px 24px color-mix(in srgb, var(--text-strong) 7%, transparent); }
  .drawer.chat-drawer { animation-fill-mode: backwards; height: auto; max-height: min(42vh, 430px); }
  .chat-drawer .sheet { max-height: 100%; overflow: visible; }
  .drawer.chat-drawer.expanded { height: calc(100dvh - 162px); max-height: none; }
  .drawer.agent-drawer { height: min(42vh, 430px); animation-fill-mode: backwards; }
  .drawer.agent-drawer.expanded { height: calc(100dvh - 162px); max-height: none; }
  .drawer.empty-chat { height: auto; min-height: 130px; max-height: 38vh; }
  .pilot-view { position: fixed; top: 100px; left: 50%; transform: translateX(-50%); width: min(calc(100vw - 2 * var(--app-gutter)), var(--app-max)); display: flex; align-items: center; gap: 14px; z-index: 1; font: 11px var(--font-mono); letter-spacing: 1.3px; text-transform: uppercase; color: var(--text-muted); pointer-events: none; }
  .pilot-view strong { color: var(--activity); flex: none; }
  .pilot-view > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pilot-error { position: fixed; bottom: 60px; left: 30px; color: var(--accent-5); font: var(--type-meta); }
  .pilot-toast { position: fixed; top: 88px; right: 24px; z-index: 20; display: flex; gap: 14px; max-width: min(420px, calc(100vw - 48px)); padding: 14px 18px; background: var(--bg); border: 1px solid var(--rule); border-radius: 10px; box-shadow: 0 8px 24px #0002; color: var(--text-strong); font: var(--type-meta); }
  .pilot-toast button { border: 0; background: transparent; color: inherit; cursor: pointer; }
  @keyframes hud-arrive {
    from { opacity: 0; transform: translate(-50%, 8px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }
  /* Expanded reading lives beside the graph on desktop. Compact and narrow
     layouts keep the bottom drawer and the existing keyboard controls. */
  .side-expanded { --text-panel-width: 52vw; }
  .side-expanded .drawer.expanded {
    left: 24px; right: auto; top: 94px; bottom: 12px;
    width: var(--text-panel-width); height: auto; max-height: none;
    transform: none; animation: none;
  }
  .side-expanded :global(.g-canvas) { left: calc(var(--text-panel-width) + 48px); right: 0; }
  .side-expanded .pilot-view { left: auto; right: 32px; transform: none; width: calc(100vw - var(--text-panel-width) - 92px); }
  @media (max-width: 640px) { .drawer { height: min(44vh, 360px); } }
  @media (prefers-reduced-motion: reduce) { .drawer { animation: none; } }
</style>
