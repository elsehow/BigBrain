<script lang="ts">
  import { applicationCursor, subscribeApplication, updatePump } from "../lib/applicationUpdates";
  import { refreshNotifications } from "../lib/notifications.svelte";
  import { getContext, onMount } from "svelte";
  import { tooltip } from "../lib/tooltip";
  import { editable } from "../lib/dom";
  import PilotsPane from "./PilotsPane.svelte";
  import { pilotRoster, type PilotRosterEntry, type PilotRequest } from "../lib/pilotAttention";
  import { work, refreshWork, refreshWorkIds } from "../lib/workSessions.svelte";
  import { chat, chatSessions, openChat, refreshChats, refreshChatIds } from "../lib/pilotChat.svelte";
  import { sourceAttention, refreshSourceAttention, unreadNodeIds, selectUnreadSources } from "../lib/sourceAttention.svelte";
  import { searchOverlay } from "../lib/omnibox.svelte";
  import { stage } from "../lib/stage.svelte";
  import { SIDEBAR_LAYOUT, type SidebarLayout } from "../lib/sidebarLayout";
  import { goto, gotoNote } from "../lib/store.svelte";
  import { agentVisualState } from "../lib/agentAppearance";
  import { sessionPath } from "../../../../lib/workSessionIdentity";
  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);
  let open = $state(false), error = $state("");
  const roster = $derived(pilotRoster(chatSessions()));
  const sidebarRoster = $derived.by(() => {
    const sessions = chatSessions();
    const entries: (PilotRosterEntry & { created: string })[] = pilotRoster(sessions, true).map(entry => ({
      ...entry, created: sessions.find(s => s.id === entry.id)!.created,
    }));
    const migrated = new Set(sessions.flatMap(s => s.legacyWork ? [s.legacyWork.id] : []));
    entries.push(...work.sessions.filter(s => !migrated.has(s.id)).map(s => ({
      archived: !!s.worker?.archivedAt || !s.worker, agentState: agentVisualState(s),
      id: s.id, lastMessageAt: s.lastMessageAt, title: s.title, phase: agentVisualState(s) === "running" ? "working" as const : "active" as const, model: s.model ?? s.provider, created: s.created,
      state: (["running", "waiting"].includes(agentVisualState(s)) ? agentVisualState(s) : "idle") as PilotRosterEntry["state"], requests: [],
    })));
    return entries.sort((a, b) => (b.lastMessageAt ?? b.created).localeCompare(a.lastMessageAt ?? a.created) || a.id.localeCompare(b.id));
  });
  const paneOpen = $derived(sidebar ? sidebar.open && sidebar.agents : open);
  const unread = $derived(unreadNodeIds(chat.graph));
  const readUnavailable = $derived(!!sourceAttention.refreshError || sourceAttention.rows.some(r =>
    r.readState.provider && (r.readState.status === "unavailable" || r.readState.status === "unknown")));
  const checkingRead = $derived(sourceAttention.loading || !sourceAttention.checked || !chat.graph);
  const unreadHint = $derived(unread.length
    ? (readUnavailable ? "Select known unread sources; some read states are unavailable" : "Select all unread sources")
    : checkingRead ? "Checking unread sources…"
    : readUnavailable ? "Could not confirm unread sources. Click to retry."
    : "No unread imported sources");
  async function refresh(history = false): Promise<void> {
    try { await Promise.all([refreshChats(), refreshWork()]); await refreshNotifications(); error = work.error; }
    catch (e) { error = (e as Error).message; }
  }
  function selectUnread(): void {
    if (!unread.length) { if (!checkingRead && readUnavailable) void refreshSourceAttention(true); return; }
    open = false; if (sidebar) { sidebar.agents = false; sidebar.tab = 'recents'; } searchOverlay.open = false; selectUnreadSources(chat.graph);
  }
  function keyboard(e: KeyboardEvent): void {
    if (sidebar || e.defaultPrevented || e.isComposing || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey
      || e.key !== "u" || editable(e.target) || (e.target instanceof Element && e.target.closest("select"))
      || searchOverlay.open || open) return;
    e.preventDefault(); selectUnread();
  }
  function show(pilot: PilotRosterEntry, request?: PilotRequest): void {
    searchOverlay.open = false;
    if (sidebar) { sidebar.agents = false; sidebar.open = true; }
    if (chat.sessions.some(s => s.id === pilot.id)) openChat(pilot.id);
    else { gotoNote(sessionPath(pilot.id)); return; }
    const notice = request?.notification;
    chat.messageTarget = notice?.messageId ?? null;
    if (notice) chat.messageJump++;
    chat.replyNotification = notice ?? null;
  }
  $effect(() => {
    const reply = chat.replyNotification;
    if (reply && chat.sessions.some(s => s.id === reply.pilotId) && !roster.some(p => p.requests.some(r => r.notification?.id === reply.id))) chat.replyNotification = null;
  });
  $effect(() => { stage.pilotsOpen = paneOpen; if (paneOpen) searchOverlay.open = false; return () => { stage.pilotsOpen = false; }; });
  // One refresh owner for the page, including live Agent session summaries.
  onMount(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>, readAt = 0;
    const pump = updatePump(async update => {
      if (update.snapshot) await Promise.all([refreshChats(), refreshWork()]);
      else {
        const pilots = update.entities.filter(e => e.kind === "pilot").map(e => e.id);
        const tasks = update.entities.filter(e => e.kind === "work").map(e => e.id);
        await Promise.all([pilots.length ? refreshChatIds(pilots) : undefined, tasks.length ? refreshWorkIds(tasks) : undefined]);
      }
      await refreshNotifications();
    });
    const unsubscribe = subscribeApplication(update => { void pump.push(update); });
    const poll = async () => {
      // Session updates also drive notifications while the window is hidden.
      if (!applicationCursor.connected) await refresh();
      if (!document.hidden && Date.now() - readAt > 60_000) { readAt = Date.now(); void refreshSourceAttention(); }
      if (!stopped) timer = setTimeout(poll, document.hidden ? 5000 : chat.sessions.some(s => s.phase === "working") ? 300 : 1500);
    };
    const focus = () => { readAt = Date.now(); void refreshSourceAttention(true); void refresh(true); };
    void poll(); window.addEventListener("focus", focus);
    return () => { stopped = true; unsubscribe(); pump.stop(); clearTimeout(timer); window.removeEventListener("focus", focus); };
  });
</script>

<svelte:window onkeydown={keyboard} />
{#if chat.historyError}<p role="alert" class="error">{chat.historyError}</p>{/if}
{#if sidebar}
  <button class="recents-trigger" aria-label="Recents" aria-keyshortcuts="r" onclick={() => sidebar.openRecents?.()} use:tooltip={"Recents (r)"}>
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></svg>
    <kbd class="keyboard-hint toolbar-key">r</kbd>
  </button>
{:else}
<span class="unread-anchor" use:tooltip={unreadHint}>
  <button class="unread" disabled={!unread.length && (checkingRead || !readUnavailable)}
    aria-label={!unread.length && readUnavailable && !checkingRead ? "Retry unread source check" : checkingRead && !unread.length ? "Checking unread sources" : `Select all ${unread.length} unread sources`}
    aria-busy={sourceAttention.loading}
    aria-keyshortcuts="u" onclick={selectUnread}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></svg>
  </button>
</span>
{/if}
<PilotsPane items={sidebar ? sidebarRoster : roster}
  bind:open={() => paneOpen, value => {
    if (sidebar) { sidebar.agents = value; if (value) { sidebar.tab = 'agents'; goto('home'); } if (value) { sidebar.searchVisible = false; sidebar.open = true; sidebar.expanded = false; } }
    else open = value;
  }} onopen={show} />
{#if error}<div class="error" role="alert">{error}<button onclick={() => { error = ""; void refresh(true); }}>Retry</button></div>{/if}

<style>
  .unread { width: var(--size-icon-btn); height: var(--size-icon-btn); border-radius: var(--r-full); background: var(--surface); border: 0; display: grid; place-items: center; color: var(--icon); cursor: pointer; flex: none; padding: 0; }
  .unread:hover { box-shadow: inset 0 0 0 1px var(--dash); }
  .unread-anchor { display: inline-flex; flex: none; }
  .unread:disabled { opacity: .4; cursor: default; pointer-events: none; }
  .error { position: absolute; right: 0; top: 100%; background: var(--bg); border: 1px solid var(--rule); border-radius: 8px; padding: 12px; font: var(--type-meta); }
  .error button { margin-left: 8px; }
</style>
