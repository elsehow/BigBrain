<script module lang="ts">
  import { workSummary } from "../../../../lib/workViews";
  // Keyed scene replacement can construct the next instance before destroying
  // the previous one. Release its globals first, rather than stacking mocks.
  let releaseActive: (() => void) | undefined;
</script>
<script lang="ts">
  import { publicPilotFixture } from "./publicPilotFixture";

  import type { Snippet } from "svelte";
  import type { WorkSession } from "../../../../lib/workHistory";
  import { onDestroy, onMount, untrack, tick } from "svelte";
  import WorkSessionPanel from "../components/WorkSessionPanel.svelte";
  import PilotChatPanel from "../components/PilotChatPanel.svelte";
  import LinkGraph from "../components/LinkGraph.svelte";
  import { work } from "../lib/workSessions.svelte";
  import { chat, openChat } from "../lib/pilotChat.svelte";
  import { app, gotoNote } from "../lib/store.svelte";
  import { editable } from "../lib/dom";
  import { newPilotChatSession, type PilotChatSession } from "../../../../lib/pilotChatTypes";
  import { withPilotChats } from "../lib/pilotChatGraph";

  import { AGENT_CHAT_GRAPH, AGENT_PILOT_ID, agentChatFixture, finishAgentFixture } from "./agentChatScenes";
  import { ATLAS_GRAPH, ATLAS_LOG, ATLAS_QUICK_LOG, atlasLogFixture } from "./agentLogReplay";
  import { ATLAS_GOAL_RUNS, ATLAS_PILOT_INSTRUCTION } from "./agentGoalReplay";

  const { scene, previewSession, headerExtra, beforeMessages, previewControls, previewAction, previewPilot, previewPilotAction }: { scene: string; previewPilot?: PilotChatSession; previewPilotAction?: (session: PilotChatSession, path: string, body: Record<string, any>) => void; previewSession?: WorkSession; headerExtra?: Snippet; beforeMessages?: Snippet; previewControls?: Snippet; previewAction?: (path: string, body: Record<string, any>) => boolean } = $props();
  untrack(() => releaseActive?.());
  const quickScene = untrack(() => scene.startsWith("quick-"));
  const goalStrategy = untrack(() => scene === "quick-goal-delta" ? "delta" : scene === "quick-goal-full" ? "full" : null);
  const goalRun = goalStrategy ? ATLAS_GOAL_RUNS[goalStrategy] : null;
  const sceneGraph = quickScene ? ATLAS_GRAPH : AGENT_CHAT_GRAPH;
  const pilotTitle = untrack(() => previewPilot?.title) ?? (quickScene ? "ATLAS · extinction probabilities" : "Dana × Arbor");
  function fixture() {
    if (previewSession) return previewSession;
    const result = quickScene ? atlasLogFixture(scene) : agentChatFixture(scene);
    if (goalRun && result.messages[0]) result.messages[0].text = ATLAS_PILOT_INSTRUCTION;
    return result;
  }
  let session = $state(untrack(fixture));
  let logCount = $state(untrack(() => scene === "quick-summarizing" ? 3 : ATLAS_LOG.length));
  let unedited = $state(false);
  const replayEntries = $derived(goalRun?.entries ?? (unedited ? ATLAS_QUICK_LOG : ATLAS_LOG));
  let summarizing = $state(untrack(() => scene === "quick-summarizing"));
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  const logPreview = $derived(quickScene ? { entries: replayEntries.slice(0, logCount), summarizing, model: "Haiku",
    through: replayEntries[Math.min(logCount, replayEntries.length) - 1]?.at ?? session.created } : undefined);
  function advanceReplay() {
    summarizing = true;
    replayTimer = setTimeout(() => {
      logCount++; summarizing = false;
      if (logCount < replayEntries.length) replayTimer = setTimeout(advanceReplay, 1800);
      else session.status = "idle";
    }, 1800);
  }
  function replay() { clearTimeout(replayTimer); logCount = 0; session.status = "working"; advanceReplay(); }
  let disconnected = $state(false), loadedOnce = false;
  let log = $state<string[]>([]), generation = $state(0);
  let expanded = $state(false), resizing = $state(false);
  let panelEl = $state<HTMLDivElement>(), pilotPanel = $state<PilotChatPanel>(), agentPanel = $state<WorkSessionPanel>();
  let animation: Animation | undefined, resizeRevision = 0;
  const parent = untrack(() => previewPilot) ?? { ...newPilotChatSession(sceneGraph.nodes.map(n => n.id), AGENT_PILOT_ID), title: pilotTitle, phase: "answered" as const,
    messages: [{ id: "launch", role: "assistant" as const, text: `Started ${untrack(() => session.title)}. The agent has the selected context; you can keep talking here while it works.`, at: new Date().toISOString() }] };
  function summary() { return workSummary(session); }
  const graph = $derived(withPilotChats(sceneGraph, chat.sessions, parent.id)!);
  const previous = untrack(() => ({ fetch: window.fetch, sessions: work.sessions, graph: work.graph, error: work.error,
    chats: chat.sessions, chatGraph: chat.graph, chatError: chat.error, activeId: chat.activeId, open: chat.open, note: app.activeNote, view: app.graphView, hash: location.hash }));
  const workerPath = untrack(() => `sessions/${session.id}.md`);
  chat.sessions = [publicPilotFixture(parent)]; chat.error = ""; chat.graph = sceneGraph;
  history.replaceState(null, "", `${location.pathname}${location.search}#/session/${parent.id}`);
  if (untrack(() => scene !== "pilot-stop")) history.pushState(null, "", `#/vault/${encodeURIComponent(workerPath)}`);
  function syncNavigation() {
    const pilotSelected = location.hash === `#/session/${parent.id}`;
    chat.activeId = pilotSelected ? parent.id : null; chat.open = pilotSelected;
    app.activeNote = location.hash.startsWith("#/vault/") ? decodeURIComponent(location.hash.slice(8)) : null;
    app.graphView = { selected: pilotSelected ? [parent.id] : app.activeNote ? [app.activeNote] : [], excluded: [] };
    expanded = false;
  }
  syncNavigation();
  const view = $derived(chat.open && chat.activeId === parent.id ? "pilot" : app.activeNote === workerPath ? "agent" : "graph");
  async function resize(next: boolean) {
    if (!panelEl || next === expanded) return;
    const from = panelEl.getBoundingClientRect().height;
    const currentPanel = view === "pilot" ? pilotPanel : agentPanel;
    const collapse = next ? undefined : currentPanel?.beginCollapse();
    animation?.cancel(); const revision = ++resizeRevision; expanded = next; resizing = true;
    await tick();
    if (panelEl && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      animation = panelEl.animate([{ height: `${from}px` }, { height: `${panelEl.getBoundingClientRect().height}px` }], { duration: 260, easing: "cubic-bezier(.22, 1, .36, 1)" });
      try { await animation.finished; } catch { /* resize reversed */ }
    }
    if (revision === resizeRevision) { collapse?.(1); resizing = false; }
  }
  $effect(() => { work.graph = graph; work.sessions = [summary()]; });
  work.error = "";
  const notice = $derived(chat.activeId === parent.id ? `Pilot selected: ${pilotTitle}` : app.activeNote && app.activeNote !== workerPath ? `Note selected: ${graph.nodes.find(n => n.path === app.activeNote)?.title ?? app.activeNote}` : "");
  function reset() {
    clearTimeout(replayTimer); logCount = scene === "quick-summarizing" ? 3 : ATLAS_LOG.length; summarizing = scene === "quick-summarizing";
    session = fixture(); disconnected = false; loadedOnce = false; log = []; work.error = ""; chat.error = "";
    chat.sessions = [publicPilotFixture({ ...parent, lifecycle: "active" })];
    history.replaceState(null, "", scene === "pilot-stop" ? `#/session/${parent.id}` : `#/vault/${encodeURIComponent(workerPath)}`);
    syncNavigation(); generation++;
  }
  const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  // Workbench already installed fakeApi. Unhandled requests stay fabricated;
  // this wrapper never forwards a worker action to a real server.
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname.startsWith("/api/pilot/chat")) {
      const p = chat.sessions.find(s => s.id === parent.id)!;
      const action = url.pathname.slice("/api/pilot/chat".length);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (!action) return reply({ sessions: chat.sessions });
      if (previewPilotAction && (action.startsWith("/access/") || action.startsWith("/browser/"))) {
        try { previewPilotAction(parent, action, body); parent.revision++; const projected = publicPilotFixture(parent); chat.sessions = [projected]; return reply(projected); }
        catch (e) { return reply({ error: e instanceof Error ? e.message : "Preview action failed" }, 409); }
      }
      if (action === "/presence") return reply({ ok: true });
      if (action === "/stop-tree") {
        if (session.status === "terminal") return reply({ error: "Return the agent from its terminal first." }, 409);
        session.status = "interrupted"; delete session.pending;
        p.lifecycle = "dormant"; p.deactivatedAt = new Date().toISOString(); log = ["Stopped Pilot and agent session · simulated locally", ...log];
      } else if (action === "/draft") p.draft = body.text;
      else return reply({ error: "This scene only simulates Pilot stop and draft actions." }, 400);
      p.revision++; return reply(p);
    }
    if (!url.pathname.startsWith("/api/pilot/work")) return previous.fetch(input, init);
    if (disconnected) return reply({ error: "Simulated connection loss" }, 503);
    const action = url.pathname.slice("/api/pilot/work".length);
    if (!action) {
      const result = reply(url.searchParams.has("id") ? session : { sessions: [summary()] });
      if (scene === "disconnected" && !loadedOnce) { loadedOnce = true; disconnected = true; }
      return result;
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    log = [`${action.slice(1)} · simulated locally`, ...log].slice(0, 6);
    if (previewAction) {
      try { if (previewAction(action, body)) return reply(session); }
      catch (e) { return reply({ error: e instanceof Error ? e.message : "Preview action failed" }, 400); }
    }
    if (action === "/stop") { session.status = "interrupted"; delete session.pending; }
    else if (action === "/open") log[0] = "Open terminal · preview only; no terminal launched";
    else if (action === "/send") {
      if (session.status === "terminal") return reply({ error: "This worker is owned by its terminal. Return it to the app before sending." }, 409);
      if (session.pending) return reply({ error: "Answer the pending question first." }, 409);
      session.messages.push({ id: crypto.randomUUID(), role: "user", at: new Date().toISOString(), text: body.text });
      session.status = "working"; delete session.error;
    } else if (action === "/respond") {
      if (!session.pending || body.requestKey !== session.pending.key) return reply({ error: "Question is no longer current." }, 409);
      session.messages.push({ id: crypto.randomUUID(), role: "user", at: new Date().toISOString(), text: body.answer.decision ?? Object.values(body.answer.answers).map((v: any) => v.answers.join(", ")).join("\n") });
      delete session.pending; session.status = "working";
    } else return reply({ error: "No simulated action for this route." }, 404);
    session.updated = new Date().toISOString();
    return reply(session);
  }) as typeof window.fetch;
  window.fetch = mockFetch;
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (view === "pilot") {
        if (pilotPanel?.handleKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) { if (e.shiftKey) pilotPanel?.shiftEscape(); else pilotPanel?.escape(); } return; }
      }
      if (!editable(e.target) && !e.shiftKey) { if (e.key === "h") { e.preventDefault(); history.back(); } else if (e.key === "l") { e.preventDefault(); history.forward(); } }
    };
    window.addEventListener("keydown", key); window.addEventListener("popstate", syncNavigation);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("popstate", syncNavigation); };
  });
  let released = false;
  const releaseGlobals = () => {
    if (released) return; released = true;
    clearTimeout(replayTimer);
    animation?.cancel();
    if (window.fetch === mockFetch) window.fetch = previous.fetch;
    work.sessions = previous.sessions; work.graph = previous.graph; work.error = previous.error;
    chat.sessions = previous.chats; chat.activeId = previous.activeId; chat.open = previous.open;
    chat.graph = previous.chatGraph; chat.error = previous.chatError;
    app.activeNote = previous.note; app.graphView = previous.view;
    history.replaceState(history.state, "", `${location.pathname}${location.search}${previous.hash}`);
    if (releaseActive === releaseGlobals) releaseActive = undefined;
  };
  releaseActive = releaseGlobals;
  onDestroy(releaseGlobals);
</script>

<div class="agent-workbench">
  <div class="controls" aria-label="Agent scene controls">
    <span>{goalRun ? `Synthetic goal-relative ${goalStrategy} · contains deliberate errors` : quickScene ? `${unedited ? "Imperfect summary example" : "Target summary example"} · invented ATLAS task · compressed replay` : "Simulated agent · production UI"}</span>
    {#if previewControls}{@render previewControls()}{:else}
    {#if quickScene}<button onclick={replay}>Replay log</button><button onclick={() => { clearTimeout(replayTimer); logCount = ATLAS_LOG.length; summarizing = false; session.status = "idle"; }}>Show complete log</button>
    {#if !goalRun}<button onclick={() => { unedited = !unedited; clearTimeout(replayTimer); logCount = replayEntries.length; summarizing = false; session.status = "idle"; }}>{unedited ? "Show target summaries" : "Show imperfect summaries"}</button>{/if}
    {:else}<button onclick={() => { finishAgentFixture(session); }}>Finish turn</button>{/if}
    <button onclick={() => { disconnected = !disconnected; if (!disconnected) work.error = ""; }}>{disconnected ? "Reconnect" : "Disconnect"}</button>
    {#if session.status === "terminal"}<button onclick={() => session.status = "idle"}>Return to app</button>{/if}
    <button onclick={reset}>Reset scene</button>
    {/if}
  </div>
  <div class="graph"><div class="pilot-view"><strong>Pilot view</strong> {pilotTitle}</div><LinkGraph data={graph} controls={false} selected={view === "pilot" ? parent.id : view === "agent" ? workerPath : null} onselect={(id) => { if (!id) return; if (id === parent.id) openChat(parent.id); else { chat.activeId = null; chat.open = false; gotoNote(id); } }} /></div>
  {#if view !== "graph"}<div class="panel" class:expanded bind:this={panelEl}>{#key generation}
    {#if view === "pilot"}<PilotChatPanel bind:this={pilotPanel} {expanded} {resizing} onresize={resize} />
    {:else}<WorkSessionPanel bind:this={agentPanel} id={session.id} {expanded} {logPreview} {headerExtra} {beforeMessages} onresize={resize} />{/if}
  {/key}</div>{:else}<button class="reopen" onclick={() => { chat.activeId = null; chat.open = false; gotoNote(workerPath); }}>Open agent</button>{/if}
  <output aria-label="Simulated actions">{notice || log[0] || "No live model calls, vault writes, or terminal launches."}</output>
</div>

<style>
  .agent-workbench { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 20px; font: var(--type-meta); border-bottom: 1px solid var(--rule); }
  .controls span { margin-right: auto; color: var(--text-muted); }
  button { font: inherit; background: var(--well); color: var(--text-strong); border: 1px solid var(--rule); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
  .graph { position: relative; flex: 1; min-height: 80px; }
  .pilot-view { position: absolute; top: 16px; left: 20px; z-index: 1; color: var(--text-muted); font: var(--type-meta); text-transform: uppercase; pointer-events: none; }
  .pilot-view strong { color: var(--activity); margin-right: 14px; }
  .panel { flex: none; height: min(42vh, 430px); margin: 0 20px; border: 1px solid var(--rule); border-radius: 14px; overflow: hidden; background: color-mix(in srgb, var(--bg) 65%, transparent); backdrop-filter: blur(12px); box-shadow: 0 10px 30px #00000009; }
  .panel.expanded { height: calc(100% - 162px); }
  .reopen { margin: 0 20px; }
  output { padding: 10px 20px; color: var(--text-muted); font: var(--type-meta); min-height: 36px; box-sizing: border-box; }
  @media (max-width: 680px) { .panel { margin: 0 8px; } .controls { padding: 8px; gap: 8px; } }
</style>
