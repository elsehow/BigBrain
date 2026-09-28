<script lang="ts">
  import { getContext, untrack } from "svelte";
  import { nativeWindowMaximized, toggleNativeWindow } from "../lib/native";
  import { singleFlight } from "../lib/singleFlight";
  import { kbdTakes } from "../lib/cursor.svelte";
  import { closeNoteTab } from "../lib/textTabs.svelte";
  import { navDelta, stepped } from "../lib/listNav";
  import { editable, isMac } from "../lib/dom";
  import { isSettingsView } from "../lib/settingsViews";
  import { app, goto, gotoNote } from "../lib/store.svelte";
  import { barUp, stage } from "../lib/stage.svelte";
  import { commandKey } from "../lib/omnibox";
  import { searchOverlay } from "../lib/omnibox.svelte";
  import { floatingResults as results, floatingSearch, warmRecents, searchPresentation, unreadSearchContext } from "../lib/floatingSearch.svelte";
  import { chatSessions, openChat } from "../lib/pilotChat.svelte";
  import { work } from "../lib/workSessions.svelte";
  import GardenerProgress from "./GardenerProgress.svelte";
  import AttentionControls from "./AttentionControls.svelte";
  import SearchResults from "./SearchResults.svelte";
  import { tooltip } from "../lib/tooltip";

  import { SIDEBAR_LAYOUT, type SidebarLayout } from "../lib/sidebarLayout";
  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);

  let maximized = $state<boolean | null>(null);
  let resizing = $state(false);
  let windowError = $state("");
  const syncWindow = singleFlight(async (): Promise<void> => { maximized = await nativeWindowMaximized(); });
  async function resizeWindow(): Promise<void> {
    if (resizing) return;
    resizing = true; windowError = "";
    try { maximized = await toggleNativeWindow(); }
    catch { windowError = "Couldn’t resize the window."; }
    finally { resizing = false; }
  }
  $effect(() => { void syncWindow(); });

  // The app's ONLY chrome, since 2026-08-10: omnibox · status · gear. The
  // 236px sidebar went when the nav it existed for came down to a single
  // row — a rail whose whole job is to show you which of one view you are
  // on is furniture, and it was costing the table a fifth of the window.
  // The wordmark went too (Nick, 2026-08-27): the field runs the width
  // now, and the window's own title bar names the app. Everything the
  // sidebar carried is here, and reachable in one click:
  //
  //   settings    the gear, which GOES there (Nick, 2026-08-11) — no menu,
  //               and no count badged on it. A menu whose rows were one
  //               destination and one debug view is a click spent choosing.
  //               INSIDE settings the gear steps out, and so does the field:
  //               the way back should be the one obvious thing (Nick,
  //               2026-08-27), not a search box that looks like the app is
  //               still underneath.
  //   window size ⤢ / ⤡ maximizes or restores the native desktop window.
  //   the way out ONE control, the bar's far right: an X, shown inside
  //               settings and on an open note, the same in both (Nick,
  //               2026-09-02: "an X in the top right, that's just sane").
  //               Esc does the same, and the X's tooltip says so. An ESC TO
  //               CLOSE label stood beside it until 2026-09-06, and made the
  //               gear step left whenever the X appeared (Nick: "that lets
  //               the buttons stay where they usually are"). From
  //               2026-08-10 the note's close was a hint under its title
  //               instead, to keep this cluster a fixed width; the corner
  //               won.
  //
  // Every hover hint here is lib/tooltip.ts, the app's one tooltip — the
  // gear and the X wore the OS's own `title` box beside tippy's until
  // 2026-09-06 (Nick: "one, app-wide tooltip lib please").
  //   home        is where every other view returns to — the X from
  //               settings or a note, clearing the search — so it needs no
  //               affordance of its own.
  //
  // The gear's tooltip said "N models configured" until 2026-08-30, off the
  // retired triage/deep models /api/vault stopped reporting. The gear goes
  // to settings, which is where the models are.
  let el = $state<HTMLInputElement | null>(null);

  const noteOpen = $derived(!!app.activeNote && app.view === "vault");
  const documentActive = $derived(noteOpen && sidebar?.tab === 'document' && !searchOverlay.open && !sidebar.agents);
  function showDocument() {
    if (!sidebar || !app.noteTab) return;
    sidebar.tab = 'document'; sidebar.open = true; sidebar.agents = false; sidebar.searchVisible = false;
    searchOverlay.open = false;
    gotoNote(app.noteTab.path);
  }
  // A note opening takes the keyboard from the field: ↵ on a hit used to
  // leave the field focused, so the j/k meant for the note's links typed
  // into the query instead (Nick, 2026-09-06: "the search bar is still
  // active … instead, the text tab should be active"). Wherever the note
  // came from — ↵ here, a click, the palette — the tab has the keys now.
  $effect(() => { void app.activeNote; untrack(() => { searchOverlay.open = false; el?.blur(); }); });
  // settings is the rail's screens (lib/settingsViews.ts — ONE list; the
  // copy kept here missed the shortcuts row, and that page took two clicks
  // to leave). Inside, the gear yields to the way out.
  const inSettings = $derived(isSettingsView(app.view));

  $effect(() => { const revision = app.rev; untrack(() => warmRecents(revision)); });

  $effect(() => {
    // Depend only on session changes, not the search cursor or result pages.
    void chatSessions(); void work.sessions;
    untrack(() => floatingSearch.reconcile());
  });
  let searchBox = $state<HTMLDivElement | null>(null);
  const hits = $derived(results.query === app.query.trim() && !results.building && !results.failed
    ? results.hits : []);
  const popup = $derived(searchOverlay.open && !inSettings);
  $effect(() => {
    if (app.view === "search" && app.query.trim()) searchOverlay.open = true;
  });
  $effect(() => {
    const query = app.query;
    const revision = app.rev;
    const unreadOnly = !!sidebar && sidebar.tab === 'recents' && !!sidebar.unreadOnly;
    const unreadSources = unreadOnly ? unreadSearchContext() : undefined;
    searchPresentation.unreadOnly = unreadOnly;
    if (popup) untrack(() => { floatingSearch.start(query, JSON.stringify({ revision, unreadOnly, unreadSources })); });
    else untrack(() => floatingSearch.cancel());
  });

  function dismissSearch(): void {
    searchOverlay.open = false;
    if (app.view === "search") goto("home");
    el?.blur();
  }
  function outside(e: PointerEvent): void {
    if (searchBox && !searchBox.contains(e.target as Node)) searchOverlay.open = false;
  }
  function openHit(index: number): void {
    const hit = hits[index];
    if (!hit) return;
    searchOverlay.open = false;
    if (sidebar) sidebar.searchVisible = false;
    el?.blur();
    kbdTakes();
    if (hit.dir === "pilot" && hit.sessionId) openChat(hit.sessionId);
    else gotoNote(hit.note.path);
  }
  function oninput(e: Event): void {
    kbdTakes();
    results.sel = 0;
    app.query = (e.currentTarget as HTMLInputElement).value;
    searchOverlay.open = true;
  }
  // Enter opens immediately; arrows scroll and page through the same list.
  // Pending or stale results cannot be opened by a fast Enter keystroke.
  function onkeydown(e: KeyboardEvent, letters = false): void {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation(); dismissSearch(); return;
    }
    if (!popup || e.isComposing) return;
    const d = navDelta(e, letters);
    if (d || e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Enter") openHit(Math.max(0, results.sel));
      else if (d && hits.length) {
        kbdTakes();
        if (d > 0 && results.sel === hits.length - 1) floatingSearch.more(true);
        else floatingSearch.select(stepped(results.sel, d, hits.length));
      }
    }
  }
  // / and the platform's command-K focus search from any screen. Escape
  // dismisses a search before closing the selected note or settings.
  // Ctrl-K on macOS remains the text field's kill-to-end-of-line shortcut.
  const mac = isMac();
  function globalKey(e: KeyboardEvent) {
    if (e.defaultPrevented || stage.pilotsOpen) return;
    const focusedControl = (e.target as Element | null)?.closest?.("button, a, summary");
    if (popup && !editable(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey &&
        (navDelta(e) || (e.key === "Enter" && !focusedControl))) {
      onkeydown(e, true); return;
    }
    // ⌘, (ctrl+, elsewhere) — the platform's own preferences key opens
    // settings (Nick, 2026-08-27); inside settings it is a no-op, and the
    // X / esc is the way back out
    if (commandKey(e, mac) && !e.altKey && e.key === ",") {
      e.preventDefault();
      if (!inSettings) { if (sidebar) sidebar.tab = "settings"; goto("vaultSettings"); }
      return;
    }
    // the omnibox owns its own Escape (blur), and DropZone its card's
    if (e.key === "Escape") {
      if (editable(e.target)) return;
      if (popup) { e.preventDefault(); dismissSearch(); return; }
      if (inSettings) goto("home"); // the X, from the keyboard
      else if (noteOpen) { e.preventDefault(); closeNoteTab(); }
      return;
    }
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (editable(e.target)) return;
    e.preventDefault();
    if (inSettings) return leaveAndFocus();
    el?.focus();
  }

  /** The field is not on this screen: go where it is, and focus it when it
   * arrives. */
  let focusOnArrival = $state(false);
  function leaveAndFocus(): void {
    focusOnArrival = true;
    goto("home");
  }
  $effect(() => {
    if (!focusOnArrival || inSettings || !el) return;
    focusOnArrival = false;
    el.focus();
  });

</script>

<svelte:window onpointerdown={outside} onkeydown={globalKey} onresize={() => void syncWindow()} onfocus={() => void syncWindow()} />

<div id="topbar" class:down={!barUp()}>
 <div class="bar">
  {#if !inSettings}
    <div class="search-box" bind:this={searchBox}>
    {#snippet searchField()}
    <label class="field" inert={sidebar ? !sidebar.searchVisible : undefined}>
      <svg width="18" height="18" viewBox="0 0 22 22" fill="none" stroke="var(--icon)"
        stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
        <circle cx="9.5" cy="9.5" r="6.5" />
        <path d="M14.5 14.5L19 19" />
      </svg>
      <input bind:this={el} type="search" placeholder="search everything…"
        value={app.query} {oninput} {onkeydown} spellcheck="false"
        onfocus={() => { stage.searchFocused = true; searchOverlay.open = true; }} onblur={() => { stage.searchFocused = false; }}
        role="combobox" aria-autocomplete="list" aria-expanded={popup} aria-controls={popup ? "search-results" : undefined}
        aria-activedescendant={popup && hits[results.sel] ? `search-hit-${results.sel}` : undefined}
        aria-label="Search the vault" />
      <span class="kbd keyboard-hint">/</span>
    </label>
    {/snippet}
    {#if !sidebar}{@render searchField()}{/if}
    {#if popup}<SearchResults {hits} onopen={openHit} searchField={sidebar?.tab === "search" ? searchField : undefined} />{/if}
    </div>
  {/if}

  <div class="right">
    {#if sidebar}
      <button class="sidebar-search-trigger" aria-label="Search" aria-keyshortcuts="/" onclick={() => sidebar.openSearch?.()} use:tooltip={"Search (/)"}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></svg>
        <kbd class="keyboard-hint toolbar-key">/</kbd>
      </button>
    {/if}
    {#if windowError}<span role="alert" class="window-error">{windowError}</span>{/if}
    {#if !inSettings || sidebar}
      <AttentionControls />
      <button class="gear" onclick={() => { if (sidebar) { sidebar.tab = "settings"; sidebar.agents = false; searchOverlay.open = false; } goto("agents"); }} use:tooltip={"Settings"} aria-label="Settings">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--icon)"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        {#if sidebar}<kbd class="keyboard-hint toolbar-key">⌘,</kbd>{/if}
      </button>
    {/if}
    {#if sidebar && app.noteTab}
      <div class="document-tab" class:active={documentActive} title={app.noteTab.title}>
        <button class="document-tab-title" aria-current={documentActive ? "page" : undefined} onclick={showDocument}>{app.noteTab.title}</button>
        <button aria-label="Close document" aria-keyshortcuts="Escape" onclick={() => sidebar.closeDocument?.()}>{#if documentActive}<span class="keyboard-hint">Esc</span>{/if}<span aria-hidden="true">×</span></button>
      </div>
    {/if}
    <!-- the corner: the view's own control — the mode on home, the way out
         everywhere else — so the gear beside it never moves (see the top) -->
    {#if !sidebar && ["home", "top", "graph"].includes(app.view) && maximized !== null}
      {@render windowButton()}
    {:else if (inSettings || noteOpen) && !sidebar}
      <button class="close" onclick={() => noteOpen ? closeNoteTab() : goto("home")} use:tooltip={"Esc to close"}
        aria-label={inSettings ? "Close settings" : "Close this note"}>
        <span class="x" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--icon)"
            stroke-width="2" stroke-linecap="round">
            <path d="M6 6L18 18M18 6L6 18" />
          </svg>
        </span>
      </button>
    {/if}
  </div>
 </div>
 {#if app.live && app.gardener}<div class="gardener"><GardenerProgress progress={app.gardener} /></div>{/if}
</div>

{#snippet windowButton()}
      <button class="mode" class:window-corner={!!sidebar} class:window-with-close={!!sidebar && (inSettings || !!sidebar.expanded)} type="button" onclick={resizeWindow} disabled={resizing}
        aria-label={maximized ? "Restore window" : "Maximize window"}
        use:tooltip={maximized ? "Restore window" : "Maximize window"}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          {#if maximized}
            <polyline points="20 10 14 10 14 4" /><polyline points="4 14 10 14 10 20" />
            <line x1="14" y1="10" x2="20" y2="4" /><line x1="10" y1="14" x2="4" y2="20" />
          {:else}
            <polyline points="14 4 20 4 20 10" /><polyline points="10 20 4 20 4 14" />
            <line x1="20" y1="4" x2="14" y2="10" /><line x1="4" y1="20" x2="10" y2="14" />
          {/if}
        </svg>
      </button>

{/snippet}

{#if sidebar && maximized !== null}
  {@render windowButton()}
{/if}

<style>
  .document-tab { order:4; display:flex; align-items:center; gap:10px; min-width:0; width:240px; max-width:calc(100vw - 272px); height:65px; box-sizing:border-box; padding:0 12px; background:transparent; border:1px solid transparent; color:var(--text-muted); font:var(--type-body); }
  .document-tab.active { background:var(--bg); border-color:var(--rule); border-bottom-color:var(--bg); color:var(--text-strong); }
  .document-tab button.document-tab-title { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; color:inherit; font:inherit; text-align:left; }
  .document-tab button { display:flex; align-items:center; gap:6px; border:0; background:transparent; color:var(--text-muted); padding:4px; cursor:pointer; }
  .document-tab button:hover { color:var(--text-strong); }
  .document-tab .keyboard-hint { font:var(--type-meta); font-size:10px; }

  .gardener { position: absolute; left: var(--app-gutter); right: var(--app-gutter); bottom: 2px; }
  .window-error { font: var(--type-meta); color: var(--accent-5); }
  /* Above the graph: the home block and the graph page reach up behind the
     bar (Nick, 2026-09-05: "the file UI overlaid on top of the graph"), so
     the bar stacks over them and wears a translucent ground — the picture
     shows through around the field, and a scrolled feed passing under is
     quietened rather than tangled with it. The height is --topbar-h. */
  #topbar { position: relative; z-index: 4; flex: 0 0 auto; padding: 18px var(--app-gutter) 22px;
    background: color-mix(in oklab, var(--bg) 68%, transparent);
    backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
    transition: transform 260ms var(--ease), opacity 200ms var(--ease); }
  /* Down: on the home screen, until /, a focused field, or a pointer at
     the top edge (lib/stage.svelte.ts). Slid off rather than removed, so
     the field is still there for / to focus — which brings it back. */
  #topbar.down { transform: translateY(-100%); opacity: 0; pointer-events: none; }
  /* The field and the status cluster are ONE bar, so the space between them
     is inside-the-row space (--sp-6, 22px), not the page gutter. It was the
     gutter (--sp-9, 34px) on the theory that the bar should keep the page's
     rhythm — but the gutter is the margin AROUND the frame, and repeating it
     inside pushed the dot and the gear off on their own island (Nick,
     2026-08-28: "tighten this gap a bit"). The bar keeps its height when the
     field is out (settings), so the content below does not jump. */
  .bar { display: flex; align-items: center; gap: var(--sp-6); min-height: 52px; }

  /* the field starts on the frame's left edge, where the lockup sat, with
     TYPES and ADDED below it */
  .search-box { display: flex; flex-direction: column; flex: 1 1 0%; min-width: 0; position: relative; }
  .field { width: 100%; max-width: none; margin: 0; box-sizing: border-box; display: flex; align-items: center; gap: var(--sp-4); height: 52px;
    padding: 0 12px; background: var(--well); border-radius: var(--r-chip); cursor: text; }
  .field svg { display: block; flex: none; }
  input { flex: 1; min-width: 0; border: none; background: none; outline: none;
    font: var(--type-chip); color: var(--text-strong); letter-spacing: -0.01em; padding: 0; }
  input:focus-visible { outline: none; }
  input::-webkit-search-cancel-button { -webkit-appearance: none; }
  /* margin-right buys OPTICAL symmetry, which the 12px padding alone does
     not give (Nick, 2026-08-10): the magnifier's 22-unit viewBox carries
     ~1.8px of empty on its left, so its INK sits 13.8px in, while the K —
     with only its 0.84px of trailing tracking — sat 12.9px in and read as
     the tighter end. The missing ~1px, so both marks are the same distance
     from the box they sit in. */
  /* the shared font/letter-spacing/color live in app.css (#265) — this scope
     layers only the positioning this one kbd chip needs */
  .kbd { flex: none; margin-right: 1px; }

  /* margin-left auto: pinned right whether or not the field is in the bar */
  .right { display: flex; align-items: center; gap: var(--sp-4); flex: none; margin-left: auto; }
  .gear, .x, .mode { width: var(--size-icon-btn); height: var(--size-icon-btn);
    border-radius: var(--r-full); background: var(--surface); border: none; display: flex;
    align-items: center; justify-content: center; cursor: pointer; flex: none; padding: 0; }
  .window-corner { position:fixed; top:calc(28px + var(--sidebar-update-height,0px)); right:24px; z-index:30; color:var(--icon); transition:opacity 220ms; }
  .window-corner.window-with-close { right:100px; }
  :global([data-sidebar-toolbar="false"]) .window-corner:not(:hover):not(:focus-visible) { opacity:0; pointer-events:none; }
  @media(prefers-reduced-motion:reduce) { .window-corner { transition:none; } }
  .gear:hover, .close:hover .x { box-shadow: inset 0 0 0 1px var(--dash); }

  /* the way out: the X alone, the same size and place as the gear beside
     it; "esc" is in its tooltip (see the top) */
  .close { display: inline-flex; align-items: center; flex: none;
    background: none; border: none; padding: 0; cursor: pointer; }
</style>
