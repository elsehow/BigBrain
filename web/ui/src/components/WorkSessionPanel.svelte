<script lang="ts">
  import { inspectActions } from "../lib/actionHistory.svelte";
  import { applicationCursor, applicationDisconnected, subscribeApplication, updatePump } from "../lib/applicationUpdates";
  import type { Snippet } from "svelte";
  import { onMount, tick } from "svelte";
  import type { WorkDetail } from "../../../../lib/workViews";
  import type { AgentLogPreview } from "../../../../lib/agentLog";
  import { workRequest } from "../lib/workSessions.svelte";
  import { app, gotoNote, showGraphSelection } from "../lib/store.svelte";
  import { md, sanitizeHtml } from "../lib/markdown";
  import { editable } from "../lib/dom";
  import TextTabResize from "./TextTabResize.svelte";
  let { id, expanded = false, onresize, headerExtra, beforeMessages }: {
    id: string; expanded?: boolean; onresize: (expanded: boolean) => void;
    logPreview?: AgentLogPreview; headerExtra?: Snippet; beforeMessages?: Snippet;
  } = $props();
  let session = $state<WorkDetail | null>(null), pollError = $state("");
  let bodyEl: HTMLDivElement;
  onMount(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const follow = !bodyEl || bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 60;
      try {
        const next = await workRequest<WorkDetail>(`?id=${encodeURIComponent(id)}`);
        if (stopped) return;
        if (!session || (next.revision ?? 0) >= (session.revision ?? 0)) session = next; pollError = "";
        if (follow) { await tick(); scrollToBottom(); }
      } catch { applicationDisconnected(); if (!stopped) pollError = "Could not refresh this conversation. Try again to read the saved history."; }

    };
    const pump = updatePump(async update => { if (update.snapshot || update.entities.some(e => e.kind === "work" && e.id === id)) await poll(); });
    const unsubscribe = subscribeApplication(update => { void pump.push(update); });
    const fallback = async () => { if (!applicationCursor.connected || !session) await poll(); if (!stopped) timer = setTimeout(fallback, 1500); };
    void fallback();
    return () => { stopped = true; unsubscribe(); pump.stop(); clearTimeout(timer); };
  });
  function key(e: KeyboardEvent) {
    if (!session?.worker || e.defaultPrevented || editable(e.target) || e.isComposing) return;
    if (e.key === 'h' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && session.origin) {
      e.preventDefault(); e.stopImmediatePropagation(); gotoNote(session.origin.pilot); return;
    }
  }
  export function escape() { app.graphView = { selected: [], excluded: [] }; showGraphSelection(null); }
  export function scrollToBottom() { if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight; }
  export function beginCollapse() { return (_progress: number) => {}; }
</script>
<svelte:window onkeydowncapture={key} />
<section aria-label="Historical conversation">
  <header>
    <h2>{session?.title ?? "Agent conversation"}</h2>
    <button onclick={() => inspectActions(undefined, "Recent actions")}>Action history</button>
    <TextTabResize {expanded} {onresize} />{@render headerExtra?.()}
  </header>
  <p>This conversation is archived. Agent execution is no longer available in BigBrain.</p>
  {#if session?.origin}<button onclick={() => gotoNote(session!.origin!.pilot)} aria-keyshortcuts="h">Back to Pilot</button>{/if}
  {#if session?.migratedToPilot}<button onclick={() => gotoNote(session!.migratedToPilot!)}>Open in Pilot</button>{/if}
  {#if session?.worker}
    <p>Working folder: {session.cwd || 'No working folder recorded'}</p>
    {#if session.worker.operations.some(op => op.status === 'uncertain')}<p role="alert">Some operations have uncertain outcomes. Inspect the working folder with your own agent.</p>{/if}
    <details><summary>Operations ({session.worker.operations.length})</summary>{#each session.worker.operations as op}<p>{op.tool}: {op.status}</p>{/each}</details>
  {/if}
  {#if pollError}<p role="alert">{pollError}</p>{/if}
  <div bind:this={bodyEl} class="messages">
    {@render beforeMessages?.()}
    {#each session?.messages ?? [] as message (message.id)}
      <article><strong>{message.role === "user" ? "Task / follow-up" : message.role === "agent" ? (session?.worker ? "Agent" : session?.provider === "claude-code" ? "Claude Code" : "Codex") : "Activity"}</strong><div>{@html sanitizeHtml(md(message.text))}</div></article>
    {/each}
    {#each session?.worker?.steering?.filter(s => s.status === "withdrawn") ?? [] as s (s.id)}
      <p>Not delivered: {s.text}{#if s.reason} ({s.reason}){/if}</p>
    {/each}
  </div>
</section>
<style>
  section { display:flex; flex-direction:column; min-height:0; height:100%; padding:var(--sp-4); gap:var(--sp-3); }
  header { display:flex; align-items:center; gap:var(--sp-3); } h2 { font:var(--type-heading); margin:0; flex:1; }
  p { color:var(--text-muted); }
  button { cursor:pointer; font:var(--type-caption); color:var(--text); background:transparent; border:1px solid var(--line); padding:var(--sp-2) var(--sp-3); } button:hover { background:var(--bg-inset); }
  .messages { overflow:auto; min-height:0; flex:1; } article { margin-bottom:var(--sp-5); overflow-wrap:anywhere; } p { margin:0; }
</style>
