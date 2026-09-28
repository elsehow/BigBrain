<script lang="ts">
  import { inspectActions } from "../lib/actionHistory.svelte";
  import { applicationCursor, applicationDisconnected, subscribeApplication, updatePump } from "../lib/applicationUpdates";
  import { deliverAction } from "../lib/actionDelivery";
  import type { Snippet } from "svelte";
  import { onMount, tick } from "svelte";
  import type { WorkDetail } from "../../../../lib/workViews";
  import type { AgentLogPreview } from "../../../../lib/agentLog";
  import { workRequest, refreshWork } from "../lib/workSessions.svelte";
  import { app, gotoNote, showGraphSelection } from "../lib/store.svelte";
  import { md, sanitizeHtml } from "../lib/markdown";
  import { agentVisualState } from "../lib/agentAppearance";
  import { editable } from "../lib/dom";
  import ProjectEnvironmentForm from "./ProjectEnvironmentForm.svelte";
  import WorkerScope from "./WorkerScope.svelte";
  import AgentIndicator from "./AgentIndicator.svelte";
  import TextTabResize from "./TextTabResize.svelte";
  let { id, expanded = false, onresize, headerExtra, beforeMessages }: {
    id: string; expanded?: boolean; onresize: (expanded: boolean) => void;
    logPreview?: AgentLogPreview; headerExtra?: Snippet; beforeMessages?: Snippet;
  } = $props();
  let session = $state<WorkDetail | null>(null), error = $state(""), pollError = $state(""), busy = $state(false);
  let setup = $state(true), configureRequest = $state(false);
  let answer = $state(""), followUp = $state("");
  let bodyEl: HTMLDivElement;
  const active = $derived(session?.worker && !session.worker.archivedAt && ["starting", "working", "needs-input"].includes(session.status));
  const status = $derived(!session ? "Loading" : !session.worker || session.worker.archivedAt ? "Archived" : session.worker.request?.kind === "context" ? "Waiting for Pilot" : session.worker.request ? "Waiting for you" : session.status === "idle" ? "Turn finished" : session.status === "interrupted" ? "Interrupted" : session.status === "failed" ? "Failed" : session.status === "starting" ? "Starting" : "Working");
  onMount(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const follow = !bodyEl || bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 60;
      try {
        const next = await workRequest<WorkDetail>(`?id=${encodeURIComponent(id)}`);
        if (stopped) return;
        if (!session || (next.revision ?? 0) >= (session.revision ?? 0)) session = next; pollError = "";
        if (follow) { await tick(); scrollToBottom(); }
      } catch { applicationDisconnected(); if (!stopped) pollError = "Could not refresh this conversation. The agent may still be running."; }

    };
    const pump = updatePump(async update => { if (update.snapshot || update.entities.some(e => e.kind === "work" && e.id === id)) await poll(); });
    const unsubscribe = subscribeApplication(update => { void pump.push(update); });
    const fallback = async () => { if (!applicationCursor.connected || !session) await poll(); if (!stopped) timer = setTimeout(fallback, 1500); };
    void fallback();
    return () => { stopped = true; unsubscribe(); pump.stop(); clearTimeout(timer); };
  });
  async function action(path: "stop" | "answer" | "approve" | "send", extra: Record<string, unknown> = {}) {
    if (busy) return;
    busy = true; error = "";
    try { session = path === "send" ? await deliverAction(actionId => workRequest<WorkDetail>(`/${path}`, { id, ...extra, actionId })) : await workRequest<WorkDetail>(`/${path}`, { id, ...extra }); answer = ""; followUp = ""; await refreshWork(); }
    catch (e) { error = e instanceof Error ? e.message : "Could not update the agent."; if (extra.environment) throw e; }
    finally { busy = false; }
  }
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
<section aria-label={session?.worker ? "Agent session conversation" : "Historical conversation"}>
  <header>
    {#if session?.worker}<AgentIndicator state={agentVisualState(session)} />{/if}
    <h2>{session?.title ?? "Agent conversation"}</h2>
    <button onclick={() => inspectActions(undefined, "Recent actions")}>Action history</button>
    <TextTabResize {expanded} {onresize} />{@render headerExtra?.()}
  </header>
  {#if session?.worker}
    <div class="status" role="status">{status}{#if session.model} · {session.model}{/if}</div>
    <div class="actions">
      {#if active}<button disabled={busy} onclick={() => action("stop")}>Interrupt</button>{/if}
      {#if session.origin}<button onclick={() => gotoNote(session!.origin!.pilot)} aria-keyshortcuts="h" aria-label="Back to Pilot">Back to Pilot <kbd>h</kbd></button>{/if}
    </div>
    <details><summary>Task access and working folder</summary><WorkerScope grant={session.worker.grant} />
      <p>Environment: <a href="#connectedAgents">{session.worker.projectId ? "View saved environment" : "Task-only access"}</a></p>
      <p>Working folder: {session.cwd || 'Awaiting authorization'}</p>
      {#if session.worker.isolation === 'checkout'}<p>Independent checkout of committed HEAD. Review changes here before applying them to your project; nothing is merged or published automatically.</p>
      {:else if session.worker.isolation === 'direct'}<p>Edits apply directly to this non-Git folder.</p>{/if}
    </details>
    {#if session.worker.request}
      {@const request = session.worker.request}
      {#if request.kind === 'context'}<p>Asked Pilot: {request.text}</p>
      {:else if request.kind === 'access'}
        <section class="request" aria-label="Project access request"><strong>{request.text}</strong>
          {#if (request.initial || configureRequest) && setup}
            {#key request.id}<ProjectEnvironmentForm project={{...request.grant,label:session.title,model:session.choice}} taskSetup chooseModel={!!request.initial} submitLabel={request.initial ? "Save environment and launch" : "Save environment and resume"} onsave={async (environment,remember)=>{await action('approve',{request:request.id,allow:true,remember,environment});}} oncancel={()=>setup=false} />{/key}
          {:else}
          <button onclick={()=>{setup=true;configureRequest=true;}}>{request.initial ? "Set up project environment" : "Update project environment"}</button>
          <WorkerScope grant={request.grant} />
          <p>{request.grant.mode === 'work' ? 'Git projects use an independent checkout of committed HEAD. Non-Git folders are edited directly.' : 'No commands or project edits.'} Network access permits sending data to the listed destinations.</p>
          <div class="actions"><button disabled={busy} onclick={()=>action('approve',{request:request.id,allow:true,remember:true})}>Remember for this project</button><button disabled={busy} onclick={()=>action('approve',{request:request.id,allow:true,remember:false})}>Allow for this task</button><button disabled={busy} onclick={()=>action('approve',{request:request.id,allow:false,remember:false})}>Decline</button></div>
          {/if}
        </section>
      {:else}<form onsubmit={e=>{e.preventDefault();void action('answer',{request:request.id,text:answer});}}><label>{request.text}<textarea bind:value={answer} required></textarea></label><button disabled={busy || !answer.trim()}>Answer</button></form>{/if}
    {/if}
    {#if session.error}<p role="alert">{session.error}</p>{/if}
    {#if session.worker.operations.some(op=>op.status === 'uncertain')}<p role="alert">Some operations have uncertain outcomes. Inspect the working folder before requesting a retry.</p>{/if}
    <details><summary>Operations ({session.worker.operations.length})</summary>{#each session.worker.operations as op}<p>{op.tool}: {op.status}</p>{/each}</details>
  {:else}
    <p>This conversation is archived. Continue it in Pilot.</p>
    {#if session?.migratedToPilot}<button onclick={() => gotoNote(session!.migratedToPilot!)}>Open in Pilot</button>{/if}
  {/if}
  {#if error || pollError}<p role="alert">{error || pollError}</p>{/if}
  <div bind:this={bodyEl} class="messages">
    {@render beforeMessages?.()}
    {#each session?.messages ?? [] as message (message.id)}
      <article><strong>{message.role === "user" ? "Task / follow-up" : message.role === "agent" ? (session?.worker ? "Agent" : session?.provider === "claude-code" ? "Claude Code" : "Codex") : "Activity"}</strong><div>{@html sanitizeHtml(md(message.text))}</div></article>
    {/each}
    {#each session?.worker?.steering?.filter(s => (s.status === "queued" && s.delivery === "steer") || (s.status === "withdrawn" && s.at > (session?.messages.at(-1)?.at ?? ""))) ?? [] as s (s.id)}
      <p>{s.status === "queued" ? "Queued for the agent" : "Not delivered"}: {s.text}{#if s.reason} ({s.reason}){/if}</p>
    {/each}
  </div>
  {#if session?.worker && !session.worker.archivedAt && !active}<form onsubmit={e=>{e.preventDefault();void action('send',{text:followUp});}}><label>Follow-up<textarea bind:value={followUp} required></textarea></label><button disabled={busy || !followUp.trim()}>Send follow-up</button></form>{/if}
</section>
<style>
  section { display:flex; flex-direction:column; min-height:0; height:100%; padding:var(--sp-4); gap:var(--sp-3); }
  header { display:flex; align-items:center; gap:var(--sp-3); } h2 { font:var(--type-heading); margin:0; flex:1; }
  .status, p { color:var(--text-muted); } .status { font:var(--type-caption); }
  .actions { display:flex; gap:var(--sp-2); flex-wrap:wrap; } button { cursor:pointer; font:var(--type-caption); color:var(--text); background:transparent; border:1px solid var(--line); padding:var(--sp-2) var(--sp-3); } button:hover { background:var(--bg-inset); } button:disabled { cursor:wait; opacity:.5; }
  form, label { display:flex; flex-direction:column; gap:var(--sp-2); } textarea { color:var(--text); background:var(--bg-inset); border:1px solid var(--line); font:inherit; padding:var(--sp-2); } .request { height:auto; overflow-y:auto; max-height:65vh; flex-shrink:1; border:1px solid var(--line); } kbd { margin-left:var(--sp-2); opacity:.6; }
  .messages { overflow:auto; min-height:0; flex:1; } article { margin-bottom:var(--sp-5); overflow-wrap:anywhere; } p { margin:0; }
</style>
