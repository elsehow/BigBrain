<script lang="ts">
  import { listTimestamp } from "../lib/listTimestamp";
  import { createListJump } from "../lib/listNav";
  const listJump = createListJump();
  import { stage } from '../lib/stage.svelte';
  import { getContext, tick } from 'svelte';
  import BlockScrollbar from "./BlockScrollbar.svelte";
  let viewport = $state<HTMLDivElement>();
  import ArchiveIcon from "./ArchiveIcon.svelte";
  import { archiveChat, chat } from "../lib/pilotChat.svelte";
  import AgentIndicator from "./AgentIndicator.svelte";
  import PilotAttentionGlyph from './PilotAttentionGlyph.svelte';
  import { TRIANGLE_PATH } from '../lib/pilotAppearance';
  import { rosterStatusView, type PilotRosterEntry, type PilotRequest } from '../lib/pilotAttention';
  import { MODEL_REGISTRY } from '../../../../lib/modelRegistry';
  import { SIDEBAR_LAYOUT, type SidebarLayout } from '../lib/sidebarLayout';
  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);
  let { items: allItems, open = $bindable(false), onopen }: { items: PilotRosterEntry[]; open?: boolean; onopen: (pilot: PilotRosterEntry, request?: PilotRequest) => void } = $props();
  let showArchived = $state(false);
  const items = $derived(sidebar ? allItems.filter(p =>
    !p.id.startsWith("work-") && (showArchived || !p.archived)
  ) : allItems);
  let archiving = $state(false), archiveError = $state(""), announcement = $state("");
  let selected = $state<string | null>(null), root: HTMLDivElement, trigger: HTMLButtonElement;
  const current = $derived(items.find(p => p.id === selected));
  const needsYou = $derived(items.some(p => p.unread ?? p.state === 'waiting'));
  const label = (model: string) => MODEL_REGISTRY.find(m => m.id === model)?.label ?? (/^gpt-.*-(astra|terra|sol|luna)$/.exec(model)?.[1]?.replace(/^./, c => c.toUpperCase()) || model);
  // The glyph is small enough that its mark alone cannot carry the status:
  // every row says the word in its accessible name and on hover.
  const status = rosterStatusView;
  function close() { open = false; trigger?.focus(); }
  function toggle() { open = !open; if (!open) trigger?.focus(); }
  function show(p: PilotRosterEntry, request = p.requests[0]) { open = false; onopen(p, request); }
  async function move(index: number) {
    const p = items[Math.max(0, Math.min(items.length - 1, index))]; if (!p) return;
    selected = p.id; await tick();
    const row = root.querySelector<HTMLButtonElement>(`[data-pilot="${CSS.escape(p.id)}"]`);
    row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: 'nearest' });
  }
  async function archive(p: PilotRosterEntry) {
    if (archiving || p.archived || p.id.startsWith("work-")) return;
    const index = items.findIndex(item => item.id === p.id);
    archiving = true; archiveError = ""; announcement = "";
    const success = await archiveChat(p.id);
    archiving = false;
    if (!success) { archiveError = chat.error || "Could not archive this agent."; return; }
    announcement = `${p.title} archived`;
    await tick();
    if (open && items.length) await move(index);
    else if (open) root.querySelector<HTMLButtonElement>(".unread-filter")?.focus();
  }
  function keyboard(e: KeyboardEvent) {
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = e.target instanceof Element && !!e.target.closest('input,textarea,select,[contenteditable="true"]');
    if (e.key === 'Escape' && e.shiftKey && open && sidebar && !typing) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat && current) void archive(current);
      return;
    }
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    if (typing || e.target instanceof Element && e.target.closest('[role="scrollbar"],.agent-filters')) return;
    if (e.key === 'a') { e.preventDefault(); e.stopImmediatePropagation(); toggle(); return; }
    if (!open) return;
    const jump = listJump(e);
    if (jump) { e.preventDefault(); e.stopImmediatePropagation(); if (jump !== 'pending') void move(jump === 'first' ? 0 : items.length - 1); return; }
    const index = items.findIndex(p => p.id === selected);
    if (['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); e.stopImmediatePropagation();
      void move(e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : index < 0 ? 0 : index + (['j', 'ArrowDown'].includes(e.key) ? 1 : -1));
    } else if (e.key === 'Enter' && current && !(e.target instanceof Element && e.target.closest('.request-open,.archive-agent'))) {
      e.preventDefault(); e.stopImmediatePropagation(); show(current);
    }
  }
  function outside(e: PointerEvent) { if (open && e.target instanceof Node && !root?.contains(e.target)) open = false; }
  $effect(() => { stage.pilotPreviewId = open ? selected : null; return () => { stage.pilotPreviewId = null; }; });
  $effect(() => { if (selected && !items.some(p => p.id === selected)) selected = null; });
</script>
<svelte:window onkeydowncapture={keyboard} onpointerdown={outside} />
<div class="pilots-anchor" bind:this={root}>
  <button class="pilots-trigger" class:pressed={open} bind:this={trigger} onclick={toggle} aria-label={sidebar ? 'Agents' : needsYou ? 'Pilots, needs you' : 'Pilots'} aria-expanded={open} aria-controls="pilots-pane" aria-keyshortcuts="a" title={sidebar ? "Agents (a)" : "Pilots"}>
    <svg width="22" height="22" viewBox="-12 -12 24 24" aria-hidden="true"><path d={TRIANGLE_PATH} fill="currentColor" /></svg>
    {#if sidebar}<kbd class="keyboard-hint agent-key">a</kbd>{/if}
    {#if !sidebar && needsYou}<i class="attention-dot" aria-hidden="true"></i>{/if}
  </button>
  {#if open}
    <section class="pilots-pane" id="pilots-pane" aria-label={sidebar ? "Agents" : "Pilots"}>
      <header class:list-title-bar={!!sidebar}><div class="list-heading"><strong>{sidebar ? "Agents" : "Pilots"} <span>{items.length}</span></strong>{#if sidebar}<div class="agent-filters"><button class="unread-filter" aria-pressed={showArchived} onclick={()=>showArchived=!showArchived}>Show archived</button></div>{/if}{#if !sidebar}<button class="close" onclick={close} aria-label="Close Pilots">×</button>{/if}</div>{#if sidebar}<div class="selection-actions keyboard-hint">j/k ↑/↓ <span>↵ open</span><span>⇧Esc archive</span></div>{/if}</header>
      {#if archiveError}<p class="archive-feedback" role="alert">{archiveError}</p>{/if}
      {#if announcement}<span class="archive-announcement" role="status">{announcement}</span>{/if}
      <div class="pilot-list" id="pilot-list" bind:this={viewport}>
        {#each items as p (p.id)}
          <div class="pilot-row-wrap" class:selected={selected === p.id}>
          <button class="pilot-row" class:selected={selected === p.id} data-pilot={p.id} onclick={() => show(p)} onfocus={() => selected = p.id} onpointermove={e => { if (e.movementX || e.movementY) selected = p.id; }} aria-label={`${p.title}, ${label(p.model)}, ${status(p).label}`}>
            {#if p.id.startsWith("work-")}<AgentIndicator state={p.agentState ?? (p.state === "running" ? "running" : p.state === "waiting" ? "waiting" : "done")} size={sidebar ? 28 : 32} />{:else}<PilotAttentionGlyph phase={p.phase} state={p.state} size={sidebar ? 28 : 32} tip={status(p).description} />{/if}
            <span class="row-copy">
              <span class="row-heading"><strong>{p.title}</strong><span class="metadata model-label">{label(p.model)}</span>{#if sidebar}<time class="message-time" datetime={p.lastMessageAt} title={p.lastMessageAt ? "Last message sent or received" : "No messages yet"}>{p.lastMessageAt ? listTimestamp(Date.parse(p.lastMessageAt)) : "—"}</time>{/if}</span>
              {#if p.preview}<span class="metadata notification-preview">{p.preview}</span>{/if}
            </span>
            {#if p.unread ?? p.state === 'waiting'}<i class="attention-dot" aria-hidden="true"></i>{/if}
          </button>
          {#if sidebar && !p.archived && !p.id.startsWith("work-")}
            <button class="archive-agent" disabled={archiving} aria-label={`Archive ${p.title}`} title="Archive (Shift-Esc)" aria-keyshortcuts="Shift+Escape" onfocus={() => selected = p.id} onclick={() => void archive(p)}><ArchiveIcon /></button>
          {/if}
          </div>
        {:else}<p class="empty">{sidebar ? "No pilot conversations yet." : "No active Pilots."}</p>{/each}
      </div>
      {#if sidebar}<BlockScrollbar {viewport} label="Scroll agents" controls="pilot-list" />{/if}
      {#if !sidebar && current?.requests.length}
        <div class="pilot-preview">
          <span class="eyebrow">Needs you</span>
          {#each current.requests as request (request.id)}
            <p>{request.text}</p>
            <button class="request-open" onclick={() => show(current, request)}>Open conversation <span>↵</span></button>
          {/each}
        </div>
      {/if}
      {#if !sidebar}<footer><span>j k / ↑ ↓ explore</span><span>↵ open</span><span>esc close</span></footer>{/if}
    </section>
  {/if}
</div>
<style>
  .pilot-row-wrap { position:relative; }
  .pilot-row-wrap:has(.archive-agent) .pilot-row { padding-right:58px; }
  .archive-agent { position:absolute; right:18px; top:50%; transform:translateY(-50%); display:grid; place-items:center; width:30px; height:30px; border:0; border-radius:4px; background:var(--bg); color:var(--ink); opacity:0; cursor:pointer; }
  .pilot-row-wrap:is(:hover,:focus-within,.selected) .archive-agent { opacity:1; }
  .pilot-row-wrap.selected .archive-agent { background:var(--text-strong); color:var(--bg); }
  .archive-agent:disabled { cursor:wait; }
  .archive-feedback { padding:8px 24px; }
  .archive-announcement { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  @media (hover:none) { .archive-agent { opacity:1; } }

  .agent-filters { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
  .agent-key { position:absolute; right:5px; bottom:1px; font:10px var(--font-mono); color:var(--text-muted); }
  .pilots-anchor { position: relative; display: inline-flex; flex: none; }
  .pilots-trigger { position: relative; width: var(--size-icon-btn); height: var(--size-icon-btn); border: 0; border-radius: var(--r-full); background: var(--surface); color: var(--icon); display: grid; place-items: center; padding: 0; cursor: pointer; }
  .pilots-trigger:hover,.pilots-trigger.pressed { box-shadow: inset 0 0 0 1px var(--rule); }
  .attention-dot { display: block; width: 7px; height: 7px; background: var(--activity); border-radius: 50%; flex: none; }
  .pilots-trigger .attention-dot { position: absolute; top: 0; right: 0; box-shadow: 0 0 0 2px var(--bg); }
  .pilots-pane { position: absolute; right: 0; top: calc(100% + 14px); width: 360px; max-width: calc(100vw - 32px); max-height: calc(100dvh - 120px); display: flex; flex-direction: column; background: var(--bg); color: var(--ink); border: 1px solid var(--rule); border-radius: 14px; box-shadow: 0 12px 35px #00000008; overflow: hidden; z-index: 100; text-align: left; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 22px; }
  header strong { font-size: 18px; font-weight: 600; }
  header span { font-size: 13px; font-weight: 400; color: var(--muted); margin-left: 8px; }
  .close { background: none; border: 0; color: var(--muted); font-size: 24px; cursor: pointer; }
  .pilot-list { overflow-y: auto; padding: 5px 12px 16px; flex: 1 1 auto; min-height: 80px; }
  .pilot-row { display: flex; align-items: flex-start; gap: 14px; width: 100%; border: 0; border-radius: 7px; background: none; color: inherit; padding: 17px 10px; text-align: left; cursor: pointer; }
  .pilot-row:is(.selected, :focus-visible) .metadata { color: inherit; opacity: .75; }
  .row-copy { flex: 1; min-width: 0; padding-top: 3px; }
  .row-heading { display:flex; align-items:baseline; gap:16px; }
  .row-heading strong { flex:1; min-width:0; }
  .message-time { flex:none; width:15ch; text-align:right; font:500 11px/1.5 var(--font-mono); letter-spacing:.08em; font-variant-numeric:tabular-nums; color:var(--text-muted); }
  .pilot-row:is(.selected, :focus-visible) .message-time { color:inherit; opacity:.75; }
  @media(max-width:600px) { .message-time { width:13ch; font-size:9px; letter-spacing:.02em; } .row-heading { gap:8px; } }
  .model-label { margin-top:0; flex:none; }
  .notification-preview { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row-copy strong { display: block; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
  .metadata { display: block; font-size: 12px; color: var(--muted); margin-top: 9px; }
  .pilot-row .attention-dot { margin-top: 9px; }
  .empty { padding: 15px; color: var(--muted); font-size: 14px; }
  .pilot-preview { border-top: 1px solid var(--rule); padding: 20px; overflow: auto; max-height: 35vh; flex: 0 1 auto; }
  .eyebrow { color: var(--activity); font: var(--type-meta); text-transform: uppercase; letter-spacing: .12em; }
  .pilot-preview p { font-size: 14px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
  .request-open { width: 100%; border: 0; background: none; color: var(--activity); padding: 6px 0; text-align: left; cursor: pointer; font-size: 13px; }
  .request-open span { float: right; }
  footer { border-top: 1px solid var(--rule); padding: 16px 22px; display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; flex: none; }
  @media(max-width: 600px) { .pilots-pane { position: fixed; top: 84px; right: 16px; } }
</style>
