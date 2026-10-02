<script lang="ts">
  import { selectedWorkspace, switchWorkspace } from '../lib/vaultScope';
  import { sharedWorkspace, checkSharedWorkspace } from '../lib/sharedWorkspace.svelte';
  import VaultSwitcher from './VaultSwitcher.svelte';
  onMount(() => {
    const unavailable = () => {
      sharedWorkspace.ready = false;
      sharedWorkspace.error = 'The shared vault is unavailable. Reconnecting…';
    };
    window.addEventListener('shared-unavailable', unavailable);
    void checkSharedWorkspace();
    const timer = selectedWorkspace ? setInterval(() => void checkSharedWorkspace(), 3000) : undefined;
    return () => { clearInterval(timer); window.removeEventListener('shared-unavailable', unavailable); };
  });
  import { onMount, setContext, tick, untrack } from 'svelte';
  import App from '../App.svelte';
  import ActionHistory from './ActionHistory.svelte';
  import { actionHistory } from '../lib/actionHistory.svelte';
  import { initializeApplicationCoordination } from '../lib/applicationCoordinator';
  initializeApplicationCoordination();
  import Feedback from './Feedback.svelte';
  import NotificationStack from './NotificationStack.svelte';
  import { notificationKeyboard } from '../lib/notificationStack.svelte';
  import NotificationTextTab from './NotificationTextTab.svelte';
  import { stackedNotifications } from '../lib/notifications.svelte';
  import { app, init, goto } from '../lib/store.svelte';
  import { searchOverlay } from '../lib/omnibox.svelte';
  import { chat, leaveChat, openChat } from '../lib/pilotChat.svelte';
  import { stage } from '../lib/stage.svelte';
  import { isSettingsView } from '../lib/settingsViews';
  import { createListJump } from '../lib/listNav';
  const listJump = createListJump();
  import { editable, popupOpen } from '../lib/dom';
  import { SIDEBAR_LAYOUT, type SidebarLayout } from '../lib/sidebarLayout';
  import '../design/sidebar.css';
  import '../design/neighborhood.css';
  import { quietSidebar } from '../lib/graphPresentation';
  import { searchPresentation } from '../lib/floatingSearch.svelte';

  const options: { baseline?: boolean; debug?: boolean } = $props();
  // The comparison workbench chooses its shell once, before children mount.
  const baseline = untrack(() => options.baseline ?? false);
  const debug = untrack(() => options.debug ?? false);
  let feedbackOpen = $state(false);
  let feedback = $state<{ key: (event: KeyboardEvent) => void }>();
  searchPresentation.includeAgents = baseline;
  const sidebar = $state<SidebarLayout>({ open: false, agents: false, searchVisible: false, expanded: false, hoverId: null });
  if (!baseline) setContext(SIDEBAR_LAYOUT, sidebar);
  sidebar.goHome = () => { void home(); };
  sidebar.openRecents = () => { void recents(); };
  sidebar.openSearch = () => { void search(); };
  // The deferred re-focus below must never undo a dismissal that happened first.
  let searchFocusFrame = 0;
  async function search(seed = '') {
    sidebar.tab = 'search';
    if (!['home', 'vault', 'search', 'graph', 'top'].includes(app.view)) goto('home');
    sidebar.open = true; sidebar.searchVisible = true; sidebar.agents = false; sidebar.expanded = false; stage.pilotsOpen = false;
    app.query = seed; searchOverlay.open = true;
    await tick();
    const focus = () => { if (sidebar.open && searchOverlay.open) document.querySelector<HTMLInputElement>('#topbar input')?.focus(); };
    focus(); cancelAnimationFrame(searchFocusFrame); searchFocusFrame = requestAnimationFrame(focus);
  }
  async function recents() {
    sidebar.tab = 'recents'; sidebar.unreadOnly = false;
    if (!['home', 'vault', 'search', 'graph', 'top'].includes(app.view)) goto('home');
    sidebar.open = true; sidebar.searchVisible = false; sidebar.agents = false; sidebar.expanded = false;
    stage.pilotsOpen = false; app.query = ''; searchOverlay.open = true;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
  function close() {
    cancelAnimationFrame(searchFocusFrame);
    sidebar.open = false; sidebar.searchVisible = false; sidebar.agents = false; sidebar.expanded = false;
    searchOverlay.open = false; stage.pilotsOpen = false;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }
  let graphReturn: string[] = [];
  $effect(() => {
    if (!chat.open) graphReturn = sidebar.homePreview ? [sidebar.homePreview] : [...app.graphView.selected];
    else untrack(() => { sidebar.conversationReturn ??= graphReturn; });
  });
  let returningHome: Promise<void> | null = null;
  function home(): Promise<void> {
    if (returningHome) return returningHome;
    returningHome = returnHome().finally(() => { returningHome = null; });
    return returningHome;
  }
  async function returnHome() {
    sidebar.documentReturn = undefined;
    const animations = sidebar.open && !matchMedia('(prefers-reduced-motion: reduce)').matches
      ? [...document.querySelectorAll<HTMLElement>('.sidebar-backplate, .sidebar-close, .search-results, .pilots-pane, .drawer:not(.sidebar-quick), #main > .settings')]
        .map(el => el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], { duration: 140, easing: 'ease-out', fill: 'forwards' }))
      : [];
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
    const returnMenu = chat.open && sidebar.conversationMenu?.agentId === chat.activeId
      ? sidebar.conversationMenu : !chat.open && sidebar.tab === 'document' ? sidebar.documentMenu : undefined;
    sidebar.documentMenu = undefined;
    sidebar.conversationMenu = undefined;
    sidebar.homeMenuResume = returnMenu;
    const returnSelection = chat.open ? sidebar.conversationReturn : undefined;
    close(); sidebar.listSelection = []; sidebar.memoryPreview = null; sidebar.hoverId = null;
    if (chat.open) void leaveChat();
    chat.open = false; chat.activeId = null;
    app.query = ''; app.graphView = { selected: [], excluded: [] };
    goto('home');
    await tick();
    sidebar.resetGraph?.();
    if (!returnMenu) sidebar.homePreview = returnSelection?.[0] ?? null;
    sidebar.conversationReturn = undefined;
    animations.forEach(animation => animation.cancel());
  }
  sidebar.closeDocument = () => {
    const returnId = sidebar.documentReturn;
    sidebar.documentReturn = undefined;
    const active = sidebar.tab === 'document' && !!app.activeNote;
    app.noteTab = null;
    if (!active) return;
    if (returnId) openChat(returnId);
    else void home();
  };
  async function dismissPanel() {
    if (app.activeNote && sidebar.tab === 'document') { sidebar.closeDocument?.(); return; }
    if (!chat.open && sidebar.dismissEditor) { sidebar.dismissEditor(); return; }
    await home();
  }
  function key(e: KeyboardEvent) {
    if ((e.target as Element | null)?.closest?.(".shared-compose, .vault-menu")) return;
    if (actionHistory.open) {
      // The modal owns keys; underlying conversation/list handlers must not act.
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { e.preventDefault(); actionHistory.open = false; }
      return;
    }
    if (feedbackOpen) { feedback?.key(e); return; }
    if (notificationKeyboard.handle(e)) return;
    wakeToolbar();
    if (sidebar.homeMenuKey?.(e)) return;
    if (baseline || e.isComposing) return;
    // Option changes e.key on macOS (e.g. Option-L is ¬); use physical codes.
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && sidebar.open
        && (!chat.open && !!document.querySelector('.agent-drawer'))
        && ['KeyH', 'KeyL'].includes(e.code)) {
      e.preventDefault(); e.stopImmediatePropagation();
      sidebar.expanded = e.code === 'KeyL';
      return;
    }
    if (e.altKey) return;
    if (chat.open && e.target instanceof Element && e.target.closest('.chat-title-input')) return;
    if (e.key === 'Escape' && chat.open && (e.shiftKey || popupOpen(e.target))) return;
    if (e.key === 'Escape' && e.shiftKey && sidebar.agents) return;
    if (e.key === 'Escape' && sidebar.tab === 'search' && sidebar.searchVisible
        && e.target instanceof HTMLInputElement && e.target.closest('#topbar')) {
      e.preventDefault(); e.stopImmediatePropagation(); cancelAnimationFrame(searchFocusFrame); e.target.blur(); return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!sidebar.open && !chat.open && !app.activeNote && !app.graphView.selected.length) {
        sidebar.homePreview = null; sidebar.homeMenuResume = undefined;
        app.graphView = { selected: [], excluded: [] };
        goto('home');
        void tick().then(() => sidebar.resetGraph?.());
        return;
      }
      const hideAfterDismiss = !!returningHome || !sidebar.open || chat.open;
      void dismissPanel().then(() => { if (hideAfterDismiss) { clearTimeout(toolbarTimer); toolbarAwake = false; uiHidden = true; } });
      return;
    }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !editable(e.target)) {
      e.preventDefault(); e.stopImmediatePropagation(); void search(); return;
    }
    if (e.metaKey || e.ctrlKey) return;
    if (sidebar.open && ['recents', 'search'].includes(sidebar.tab ?? '') && sidebar.listAction && !editable(e.target)) {
      const jump = listJump(e);
      if (jump) { e.preventDefault(); e.stopImmediatePropagation(); if (jump !== 'pending') sidebar.listAction(jump); return; }
      const action = !e.shiftKey && e.key === 'x' ? 'toggle' : e.shiftKey && e.key === 'Enter' ? 'pilot' : e.shiftKey && e.key.toLowerCase() === 'u' ? 'read' : null;
      if (action) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) sidebar.listAction(action); return; }
    }
    if (sidebar.open && sidebar.tab === 'recents' && e.key.toLowerCase() === 'u' && !editable(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); sidebar.unreadOnly = !sidebar.unreadOnly; return; }
    if (!chat.open && e.key.toLowerCase() === 'r' && !editable(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); void recents(); return; }
    const conversation = chat.open || !!document.querySelector('.agent-drawer');
    if (sidebar.open && !chat.open && conversation && e.shiftKey && e.key === 'ArrowLeft') {
      e.preventDefault(); e.stopImmediatePropagation();
      sidebar.expanded = !sidebar.expanded;
      return;
    }
    if (conversation && e.shiftKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) { e.stopImmediatePropagation(); return; }
  }
  let uiHidden = $state(false);
  let toolbarAwake = $state(true);
  let toolbarTimer: ReturnType<typeof setTimeout>;
  $effect(() => { if (stackedNotifications().length) untrack(() => wakeToolbar()); });
  function wakeToolbar() {
    uiHidden = false;
    toolbarAwake = true;
    clearTimeout(toolbarTimer);
    toolbarTimer = setTimeout(() => { toolbarAwake = false; }, 2500);
  }
  // Register before App mounts, so the experiment owns Escape and the sidebar shortcuts.
  window.addEventListener('keydown', key, true);
  function reportCamera() { document.querySelector('.sidebar-camera')!.textContent = JSON.stringify(sidebar.camera?.()); document.querySelector('.sidebar-presentation')!.textContent = JSON.stringify({ ...(sidebar.presentation?.() as object), committed: app.graphView }); }
  if (debug) window.addEventListener('sidebar:camera', reportCamera);
  $effect(() => {
    if (chat.open && chat.activeId) untrack(() => {
      sidebar.tab = 'agents'; sidebar.agents = false;
      sidebar.searchVisible = false; searchOverlay.open = false; stage.pilotsOpen = false;
    });
  });
  $effect(() => {
    const target = app.activeNote ?? (chat.open ? chat.activeId : null);
    const view = app.view;
    if (app.activeNote && view === 'vault') { sidebar.tab = 'document'; sidebar.agents = false; sidebar.expanded = false; }
    else if (isSettingsView(view)) sidebar.tab = 'settings';
    else if (sidebar.tab === 'settings') { sidebar.tab = undefined; sidebar.expanded = false; }
    if (sidebar.memoryPreview && target === sidebar.memoryPreview && !chat.open) return;
    if (sidebar.memoryPreview) sidebar.memoryPreview = null;
    if (target || !['home', 'graph', 'top', 'search'].includes(view)) { sidebar.open = true; sidebar.searchVisible = false; }
  });
  $effect(() => {
    if (!baseline) {
      document.documentElement.dataset.sidebarTone = quietSidebar ? 'calm' : 'original';
      document.documentElement.dataset.sidebarWorkbench = sidebar.open ? 'open' : 'closed';
      sidebar.fullscreenChat = chat.open && !sidebar.agents && !searchOverlay.open && !stage.pilotsOpen;
      document.documentElement.dataset.fullscreenChat = String(sidebar.fullscreenChat);
      document.documentElement.dataset.sidebarExpanded = String(sidebar.expanded);
      document.documentElement.dataset.sidebarSettings = String(isSettingsView(app.view));
      document.documentElement.dataset.sidebarAgents = String(sidebar.agents);
      document.documentElement.dataset.sidebarSearch = String(sidebar.searchVisible);
      document.documentElement.dataset.sidebarToolbar = String(sidebar.open || toolbarAwake);
      document.documentElement.dataset.sidebarHidden = String(uiHidden);
      document.documentElement.dataset.sidebarTab = sidebar.tab ?? 'detail';
    }
  });
  onMount(() => {
    init();
    wakeToolbar();
    window.addEventListener('pointermove', wakeToolbar);
    let measureFrame = 0;
    const measure = () => {
      measureFrame = 0;
      const bar = document.querySelector('#topbar');
      if (!bar) return;
      const value = `${bar.getBoundingClientRect().height + 24 + (document.querySelector(".sidebar-nudge")?.getBoundingClientRect().height ?? 0)}px`;
      if (document.documentElement.style.getPropertyValue('--sidebar-content-top') !== value) document.documentElement.style.setProperty('--sidebar-content-top', value);
    };
    // Do not write layout during resize delivery or re-observe unchanged nodes
    // on every graph/menu insertion; both can restart WebKit's resize loop.
    const observe = new ResizeObserver(() => { if (!measureFrame) measureFrame = requestAnimationFrame(measure); });
    let watched: Element[] = [];
    const reconnect = () => {
      const next = [document.querySelector('#topbar'), document.querySelector('.sidebar-nudge')].filter((node): node is Element => !!node);
      for (const node of watched) if (!next.includes(node)) observe.unobserve(node);
      for (const node of next) if (!watched.includes(node)) observe.observe(node);
      watched = next;
    };
    const connect = new MutationObserver(reconnect);
    connect.observe(document.body, { childList: true, subtree: true });
    reconnect();
    return () => { cancelAnimationFrame(measureFrame); clearTimeout(toolbarTimer); window.removeEventListener('pointermove', wakeToolbar); delete document.documentElement.dataset.sidebarToolbar; delete document.documentElement.dataset.sidebarHidden; delete document.documentElement.dataset.sidebarTab; delete document.documentElement.dataset.sidebarSettings; observe.disconnect(); connect.disconnect(); window.removeEventListener('keydown', key, true); window.removeEventListener('sidebar:camera', reportCamera); delete document.documentElement.dataset.sidebarWorkbench; delete document.documentElement.dataset.sidebarTone; delete document.documentElement.dataset.sidebarExpanded; delete document.documentElement.dataset.fullscreenChat; delete document.documentElement.dataset.sidebarAgents; delete document.documentElement.dataset.sidebarSearch; };
  });
</script>

{#if sharedWorkspace.ready}
<App />
{#if actionHistory.open}<ActionHistory />{/if}
<Feedback bind:this={feedback} bind:open={feedbackOpen} visible={baseline || (!uiHidden && (sidebar.open || toolbarAwake))}
  panel={isSettingsView(app.view) ? 'settings' : chat.open ? 'conversation' : sidebar.tab === 'document' ? 'document' : sidebar.searchVisible ? 'search' : sidebar.open && sidebar.tab === 'recents' ? 'recents' : app.view === 'home' ? 'home' : app.view === 'graph' ? 'graph' : 'other'}
  expanded={sidebar.expanded} wake={wakeToolbar} />
<NotificationStack />
{#if !baseline}
  {#if debug}<output class="sidebar-presentation" hidden aria-label="Workbench presentation"></output>
  <output class="sidebar-camera" hidden aria-label="Workbench camera">{JSON.stringify(sidebar.camera?.())}</output>{/if}
  <NotificationTextTab />
  <div class="sidebar-backplate" aria-hidden="true"></div>
  {#if sidebar.open && !(app.activeNote && sidebar.tab === 'document')}
    <button class="sidebar-close" aria-label={chat.open ? "Close conversation" : "Close sidebar"} aria-keyshortcuts="Escape" onclick={() => void dismissPanel()}>
      <kbd class="keyboard-hint">Esc</kbd><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>
    </button>
  {/if}

{/if}

{:else}
  <div style="padding: 32px; color: var(--text); font: var(--type-meta)">
    <VaultSwitcher />
    <p role="status">{sharedWorkspace.error || 'Connecting to shared vault…'}</p>
    {#if sharedWorkspace.error}<button onclick={() => void checkSharedWorkspace()}>Retry</button> <button onclick={() => switchWorkspace(null)}>Personal vault</button>{/if}
  </div>
{/if}
