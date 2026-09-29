<script lang="ts">
  import VaultSwitcher from "./VaultSwitcher.svelte";
  import {selectedWorkspace} from "../lib/vaultScope";
  import ArchiveIcon from "./ArchiveIcon.svelte";
  import { onMount, tick } from 'svelte';
  import type { GraphNode } from '../lib/types';
  import type { SidebarLayout } from '../lib/sidebarLayout';
  import { archiveChat, chatSessions, openChat, startChat, chat } from '../lib/pilotChat.svelte';
  import { GENERAL_WORKSPACE, workspaceMembershipIndex } from '../lib/workspaceMembership';
  import { pilotRoster, rosterStatusView, type PilotRosterEntry } from '../lib/pilotAttention';
  import { navDelta, stepped, createListJump } from '../lib/listNav';
  import { editable } from '../lib/dom';
  import { searchOverlay } from '../lib/omnibox.svelte';
  import { gotoNote } from '../lib/store.svelte';
  import { stage } from '../lib/stage.svelte';
  import ListNavigationHint from '../components/ListNavigationHint.svelte';
  import PilotAttentionGlyph from '../components/PilotAttentionGlyph.svelte';
  let { memories, sidebar }: { memories: GraphNode[]; sidebar: SidebarLayout } = $props();
  let open = $state(!!selectedWorkspace||new URL(location.href).searchParams.has("vaultMenu"));
  let index = $state(0);
  let selectedId = $state<string | null>(null);
  const general: GraphNode = { id: GENERAL_WORKSPACE, title: 'Uncategorized agents', group: 'memory', degree: 0 };
  let root = $state<HTMLElement>();
  $effect(() => {
    const el = root;
    if (!el || !open) { sidebar.homeMenuRight = 0; return; }
    const measure = () => { sidebar.homeMenuRight = el.getBoundingClientRect().right; };
    const observer = new ResizeObserver(measure); observer.observe(el);
    window.addEventListener('resize', measure); measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); sidebar.homeMenuRight = 0; };
  });
  let error = $state('');
  let archiving = $state(false);
  let archiveRow = $state<Row | null>(null);
  let archiveIndex = 0;
  let archivedId = $state<string | null>(null);
  let announcement = $state('');
  const jump = createListJump();
  let pointer = { x: -1, y: -1 };
  function trackPointer(e: PointerEvent) { pointer = { x: e.clientX, y: e.clientY }; }
  const roster = $derived(pilotRoster((selectedWorkspace?[]:chatSessions()).map(session => ({ ...session, draft: chat.drafts[session.id] ?? session.draft }))));
  const membershipIndex = $derived(workspaceMembershipIndex(memories));
  const agentsByWorkspace = $derived.by(() => {
    const active = new Set(roster.map(agent => agent.id));
    const membership = membershipIndex.forAgents(chatSessions().filter(session => active.has(session.id)));
    const grouped = new Map<string, typeof roster>();
    for (const agent of roster) for (const id of membership.get(agent.id) ?? []) {
      const group = grouped.get(id) ?? [];
      group.push(agent);
      grouped.set(id, group);
    }
    return grouped;
  });
  const workspaces = $derived([...memories, ...(agentsByWorkspace.get(GENERAL_WORKSPACE)?.length ? [general] : [])]);
  const needsAttention = $derived(new Set(
    [...agentsByWorkspace].filter(([, agents]) => agents.some(agent => agent.unread || agent.state === 'waiting')).map(([id]) => id)
  ));
  type Row = { id: string; memory: GraphNode; agent?: PilotRosterEntry };
  const rows = $derived.by(() => {
    const list = workspaces.flatMap<Row>(memory => [
    { id: memory.id, memory },
    ...(agentsByWorkspace.get(memory.id) ?? []).map(agent => ({ id: agent.id, memory, agent })),
    ]);
    // Keep the confirmed archive visible briefly before collapsing its row.
    if (archiveRow && !list.some(row => row.id === archiveRow?.id)) list.splice(archiveIndex, 0, archiveRow);
    return list;
  });
  const count = $derived(rows.length);
  const selected = $derived(rows[index]);
  $effect(() => {
    const at = rows.findIndex(row => row.id === selectedId);
    index = at >= 0 ? at : Math.min(index, Math.max(0, count - 1));
    selectedId = rows[index]?.id ?? null;
  });
  $effect(() => {
    sidebar.homePreview = open && selected?.id !== GENERAL_WORKSPACE ? selected?.id ?? null : null;
  });
  function selectIndex(at: number) { index = at; selectedId = rows[at]?.id ?? null; }
  function hover(e: PointerEvent, at: number) {
    // A menu moving under a stationary pointer must not override keyboard selection.
    if (e.clientX !== pointer.x || e.clientY !== pointer.y) selectIndex(at);
  }
  async function close() {
    if (document.activeElement instanceof HTMLElement && root?.contains(document.activeElement)) document.activeElement.blur();
    open = false;
    await tick(); sidebar.resetGraph?.();
  }
  async function focusRow() {
    await tick();
    const row = root?.querySelectorAll<HTMLButtonElement>('.menu-row')[index];
    row?.focus({ preventScroll: true }); row?.scrollIntoView({ block:'nearest' });
  }
  function choose(at: number) {
    selectIndex(at); error = '';
    const row = rows[at];
    if (!row || row.id === archivedId) return;
    if (!row.agent) {
      if (row.memory.id !== GENERAL_WORKSPACE) {
        sidebar.documentMenu = { workspaceId: row.memory.id };
        gotoNote(row.memory.path ?? row.memory.id);
      }
      return;
    }
    sidebar.conversationReturn = row.memory.id === GENERAL_WORKSPACE ? [] : [row.memory.id];
    sidebar.conversationMenu = { workspaceId: row.memory.id, agentId: row.agent.id };
    openChat(row.agent.id, { focus: false });
  }
  async function archiveSelected() {
    const agent = selected?.agent;
    if (!agent || archiving) return;
    archiving = true; error = ''; announcement = '';
    archiveRow = selected; archiveIndex = index;
    const archived = await archiveChat(agent.id);
    if (!archived) { archiveRow = null; archiving = false; error = chat.error || 'Could not archive this agent.'; return; }
    archivedId = agent.id;
    announcement = agent.title + ' archived';
    await new Promise(resolve => setTimeout(resolve, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150));
    archiveRow = null; archivedId = null; archiving = false;
    await tick();
    if (open) void focusRow();
  }
  async function createAgent(memory: GraphNode) {
    sidebar.conversationReturn = memory.id === GENERAL_WORKSPACE ? [] : [memory.id];
    try {
      const opening = startChat(memory.id === GENERAL_WORKSPACE ? [] : [memory.id]);
      if (chat.activeId) sidebar.conversationMenu = { workspaceId: memory.id, agentId: chat.activeId };
      await opening;
    } catch (e) { error = (e as Error).message; }
  }
  function key(e: KeyboardEvent): boolean {
    if ((e.target instanceof Element&&e.target.closest('nav[aria-label="Vaults"]')) || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || editable(e.target)
      || sidebar.open || chat.open || searchOverlay.open || stage.pilotsOpen) return false;
    if (!open) {
      if (e.shiftKey || !['j', 'k'].includes(e.key) || !count) return false;
      e.preventDefault(); e.stopImmediatePropagation();
      open = true; selectIndex(e.key === 'j' ? 0 : count - 1);
      void focusRow(); return true;
    }
    if (e.key === 'Enter' && e.shiftKey) {
      const memory = selected && !selected.agent ? selected.memory : undefined;
      e.preventDefault(); e.stopImmediatePropagation();
      if (memory && !e.repeat) void createAgent(memory);
      return true;
    }
    if (e.key === 'Escape' && e.shiftKey) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) void archiveSelected();
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      void close();
      return true;
    }
    const endpoint = jump(e), delta = navDelta(e);
    const enter = e.key === 'Enter' || e.key === 'l';
    if (!endpoint && !delta && !enter) return false;
    if (e.shiftKey && e.key !== 'G') return false;
    e.preventDefault(); e.stopImmediatePropagation();
    if (enter) { if (!e.repeat) choose(index); }
    else if (endpoint) { if (endpoint !== 'pending') { selectIndex(endpoint === 'first' ? 0 : Math.max(0,count - 1)); void focusRow(); } }
    else if (delta) { selectIndex(stepped(index, delta, count)); void focusRow(); }
    return true;
  }
  onMount(() => {
    const resume = sidebar.homeMenuResume;
    sidebar.homeMenuResume = undefined;
    if (resume) {
      const agentIndex = resume.agentId ? rows.findIndex(row => row.agent?.id === resume.agentId) : -1;
      selectIndex(agentIndex >= 0 ? agentIndex : Math.max(0, rows.findIndex(row => row.id === resume.workspaceId)));
      open = true;
      void focusRow();
    }
    sidebar.homeMenuKey = key;
    window.addEventListener('pointermove', trackPointer);
    return () => { sidebar.homeMenuKey = undefined; sidebar.homePreview = null; window.removeEventListener('pointermove', trackPointer); };
  });
</script>
{#if open}
<section class="workspace-menu" aria-label="Memories and active agents" bind:this={root}>
  <div class="menu-rows">
    {#each rows as row, i (row.id)}
      <button class="menu-row" class:agent-row={!!row.agent} class:memory-row={!row.agent}
        data-workspace-id={row.memory.id} data-agent-id={row.agent?.id}
        class:archived={archivedId === row.id} class:current={index === i} aria-current={index === i ? 'true' : undefined}
        onfocus={() => selectIndex(i)} onpointerenter={e => hover(e, i)} onpointermove={e => hover(e, i)} onclick={() => choose(i)}>
        {#if row.agent}
          <PilotAttentionGlyph phase={row.agent.phase} state={row.agent.state} size={20} tip={rosterStatusView(row.agent).description} />
          <span class="title">{row.agent.title}</span>
          {#if row.agent.unread || row.agent.state === 'waiting'}<span class="attention" aria-label="Needs attention"></span>{/if}
          <span class="meta" class:hide-status={index === i}>{rosterStatusView(row.agent).label}</span>
        {:else}
          <span class="title">{row.memory.title}</span>
          {#if needsAttention.has(row.memory.id)}<span class="attention" aria-label="Needs attention"></span>{/if}
        {/if}
        {#if archivedId === row.id}
          <span class="row-hints"><ArchiveIcon /> Archived</span>
        {:else if index === i}
          <span class="row-hints" aria-hidden="true">
            {#if row.id !== GENERAL_WORKSPACE}<span><kbd>↵</kbd> Open</span>{/if}
            {#if row.agent}<span><ArchiveIcon /><kbd>⇧Esc</kbd></span>
            {:else}<span><kbd>⇧↵</kbd> Attach a pilot</span>{/if}
          </span>
        {/if}
      </button>
    {/each}
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  <footer>
    <ListNavigationHint />
    <span class="archive-status" role="status">{announcement}</span>
  </footer>
  <VaultSwitcher />
</section>
{:else}
  <div class="workspace-menu-hint"><ListNavigationHint /></div>
{/if}
<style>
  .workspace-menu-hint { position:fixed; left:32px; top:calc(88px + var(--sidebar-update-height,0px)); z-index:3; pointer-events:none; }
  .workspace-menu-hint :global(.list-navigation-hint) { padding:0; font-size:12px; }
  .workspace-menu { position:fixed; z-index:3; left:20px; top:96px; width:min(460px,calc(100vw - 40px)); max-height:calc(100dvh - 160px); display:flex; flex-direction:column; background:var(--panel-bg); backdrop-filter:var(--panel-blur); -webkit-backdrop-filter:var(--panel-blur); color:var(--text-strong); }
  .menu-rows { overflow:auto; min-height:0; }
  .menu-row { box-sizing:border-box; display:flex; align-items:center; gap:10px; width:100%; height:39px; text-align:left; border:0; padding:9px 16px; background:transparent; color:inherit; font:500 15px/1.4 var(--font-app); cursor:pointer; }
  .agent-row { font-weight:400; }
  /* The triangle is inset within its 20px status canvas. Align its visible edge. */
  .agent-row :global(.glyph) { margin-left:-6.75px; }
  .memory-row:not(:first-child) { border-top:1px solid var(--rule); }
  .menu-row.current, .menu-row:hover { background:var(--text-strong); color:var(--bg); --glyph-bg:var(--text-strong); --mark:var(--bg); }
  .menu-row:focus-visible { outline:none; }
  .title { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .meta { flex:none; font:var(--type-meta); opacity:.65; }
  .attention { flex:none; width:6px; height:6px; border-radius:50%; background:currentColor; }
  footer { display:flex; flex:none; flex-wrap:wrap; align-items:center; padding:8px 16px; gap:12px; font:12px/1.4 var(--font-app); color:var(--text-muted); }
  footer :global(.list-navigation-hint) { padding:0; font-size:inherit; }
  .row-hints { display:flex; flex:none; align-items:center; gap:14px; font:12px/1.4 var(--font-app); }
  .row-hints > span { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; }
  .hide-status { display:none; }
  kbd { font:inherit; opacity:.65; }
  .archive-status { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .archived { pointer-events:none; animation:archive-away 150ms ease-out forwards; }
  @keyframes archive-away {
    0% { opacity:1; transform:translateX(0); }
    100% { opacity:0; transform:translateX(18px); }
  }
  @media (prefers-reduced-motion:reduce) { .archived { animation:none; } }
  @media (max-width:600px) {
    .menu-row.current { flex-wrap:wrap; height:auto; min-height:39px; }
    .row-hints { width:100%; justify-content:flex-end; }
  }

</style>
