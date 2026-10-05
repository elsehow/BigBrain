<script lang="ts">
  import { chat } from "./lib/pilotChat.svelte";
  import { navigateHistory } from "./lib/routeHistory.svelte";
  import { keyboardHints } from "./lib/keyboardHints.svelte";
  $effect(() => { document.documentElement.dataset.keyboardHints = keyboardHints.show ? "on" : "off"; });
  import { getContext } from "svelte";
  import { SIDEBAR_LAYOUT, type SidebarLayout } from "./lib/sidebarLayout";
  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);
  import DropZone from "./components/DropZone.svelte";
  import HomeView from "./components/HomeView.svelte";
  import SettingsScreens from "./components/SettingsScreens.svelte";
  import TopBar from "./components/TopBar.svelte";
  import UpdateNudge from "./components/UpdateNudge.svelte";
  import { cursor, kbdTakes, mouseTakes } from "./lib/cursor.svelte";
  import { editable } from "./lib/dom";
  import { openExternalLinks } from "./lib/links";
  import { pilot, pilotClearContext } from "./lib/pilot.svelte";
  import type { SetupState } from "./lib/setup";
  import { app, gotoNote } from "./lib/store.svelte";

  // First run is the base's (components/FirstRunGate.svelte); the classic
  // view is handed the setup state it reads (the identity, for the graph).
  const { setup }: { setup: SetupState | null } = $props();

  $effect(() => {
    const names = { sharedVaultSettings: "Shared vaults", home: "Home", top: "Top", vault: "Vault", graph: "Graph", connectedClients: "Connected Clients", pilotSettings: "Pilot", integrations: "Integrations", agents: "Models", vaultSettings: "General", themes: "General", diagnostics: "Diagnostics", search: "Search" };
    document.title = `${names[app.view]} — BigBrain`;
  });

  // One input owns selection at a time (lib/cursor.svelte.ts): the mode
  // rides on <body> so every list's styles can gate hover vs keyboard
  // cursor without prop-drilling.
  $effect(() => {
    document.body.classList.toggle("kbd-nav", cursor.input === "kbd");
  });
  // Tab follows normal focus order; j/k and the arrows navigate note links.
  // h/l are the HISTORY, back and forward (Nick, 2026-09-06: "h/l should
  // navigate forward/back when bopping around nodes"): every note opened
  // is a hash the browser remembers, so a walk through the picture can be
  // retraced the way j/k walk a list. Not from a field, and bare — ⌘h and
  // ⌘l are the platform's.
  function onKey(e: KeyboardEvent) {
    if (e.key === "Tab") kbdTakes();
    if (chat.open || editable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "h") { e.preventDefault(); navigateHistory('back'); }
    else if (e.key === "l") { e.preventDefault(); navigateHistory('forward'); }
  }
  function onKeyCapture(e: KeyboardEvent) {
    // Once list navigation starts, Enter belongs to the selected row.
    if (!e.metaKey && !e.ctrlKey && !e.altKey && ["j", "k", "ArrowUp", "ArrowDown"].includes(e.key)) {
      const target = e.target as HTMLElement | null;
      if (target?.getAttribute("role") === "tab") target.blur();
    }
    if (e.code !== "KeyC" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !pilot.open) return;
    const target = e.target as HTMLElement | null;
    if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
    e.preventDefault(); e.stopPropagation(); pilotClearContext();
  }
</script>

<!-- onclick: a link that leaves the document opens OUTSIDE the app
     (lib/links.ts) — the shell's webview has no way back from a page -->
<svelte:window onmousemove={mouseTakes} onkeydowncapture={onKeyCapture} onkeydown={onKey} onclick={openExternalLinks} />

<DropZone />
<!-- one column: the top bar is the whole chrome (the 236px nav rail went
     on 2026-08-10, with the last view it could switch between) -->
<div id="main">
  <UpdateNudge />
  <TopBar />
  {#if sidebar || app.view === "home" || app.view === "top" || app.view === "graph" || app.view === "search" || app.view === "vault"}
    <!-- THE screen (HomeView): the graph as the ground and the text tab
         over it — the recents, a search's hits, or an open note's
         assertions, by the hash. Search and the note were screens of
         their own until 2026-09-06; #/graph was the full-page graph until
         2026-09-05. Every one of those hashes lands here. -->
    <HomeView identity={setup?.identity ?? null} />
  {/if}
  <SettingsScreens />
</div>


