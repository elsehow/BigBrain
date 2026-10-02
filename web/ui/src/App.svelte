<script lang="ts">
  import SharedVaultSettings from "./components/SharedVaultSettings.svelte";
  import ConnectedClientsView from "./components/ConnectedClientsView.svelte";
  import { chat } from "./lib/pilotChat.svelte";
  import { navigateHistory } from "./lib/routeHistory.svelte";
  import { keyboardHints } from "./lib/keyboardHints.svelte";
  $effect(() => { document.documentElement.dataset.keyboardHints = keyboardHints.show ? "on" : "off"; });
  import { getContext } from "svelte";
  import { SIDEBAR_LAYOUT, type SidebarLayout } from "./lib/sidebarLayout";
  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);
  import { startTelemetryPresence, telemetryState, type TelemetrySnapshot } from "./lib/telemetry";
  $effect(() => startTelemetryPresence());
  import PilotSettingsView from "./components/PilotSettingsView.svelte";
  import AgentsView from "./components/AgentsView.svelte";
  import DiagnosticsView from "./components/DiagnosticsView.svelte";
  import DropZone from "./components/DropZone.svelte";
  import FirstRun from "./components/FirstRun.svelte";
  import HomeView from "./components/HomeView.svelte";
  import IntegrationsView from "./components/IntegrationsView.svelte";
  import TopBar from "./components/TopBar.svelte";
  import UpdateNudge from "./components/UpdateNudge.svelte";
  import VaultSettingsView from "./components/VaultSettingsView.svelte";
  import { cursor, kbdTakes, mouseTakes } from "./lib/cursor.svelte";
  import { editable } from "./lib/dom";
  import { openExternalLinks } from "./lib/links";
  import { pilot, pilotClearContext } from "./lib/pilot.svelte";
  import { connectClaude, declareName, pickVault, setupDone, setupStatus, type SetupState } from "./lib/setup";
  import { startUpdateChecks } from "./lib/update.svelte";
  import { app, gotoNote } from "./lib/store.svelte";

  // FIRST RUN (#575). The setup door answers /api/setup under the desktop
  // app. Vault, identity and provider setup precede the installation-local
  // sharing choice. Either sharing answer completes setup. No door (a headless host,
  // an older engine) ⇒ null ⇒ the app as it always was. While the screens
  // are up they re-check on a short clock — Claude Code gets installed in
  // a terminal, and the door hands the port to the engine after step 1 —
  // and a miss on that clock (the handover's gap) keeps the last answer
  // rather than flashing the app.
  // undefined = not answered yet (or not reachable): decide nothing, keep
  // what was last known. null = the engine said there is no door.
  let setup = $state<SetupState | null | undefined>(undefined);
  let sharing = $state<TelemetrySnapshot | null | undefined>(undefined);
  const telemetryPending = $derived(!!sharing?.configured && !sharing.decided);
  const firstRun = $derived(!!setup && !setupDone(setup));
  const waiting = $derived(setup === undefined || (!!setup && sharing === undefined));
  let pickingVault = false, setupEpoch = 0;
  async function refreshSetup(): Promise<void> {
    if (pickingVault) return;
    const epoch = setupEpoch;
    try {
      const next = await setupStatus();
      if (pickingVault || epoch !== setupEpoch) return;
      // A status poll carries no verdict about the folder the user just tried.
      // Retain that actionable error until another choice or vault takes over.
      if (next && setup?.pick && next.vault?.path === setup.vault?.path && !next.pick) next.pick = setup.pick;
      setup = next;
      if (setup && sharing == null) {
        try { sharing = await telemetryState(); }
        catch { sharing = null; } // Unavailable diagnostics must not block setup.
      }
    } catch {
      /* the engine is not answering — a handover, a restart: keep the last answer, ask again */
    }
  }
  // On mount and on every live ping (a connect on the agents card changes
  // the answer, and the top bar's dot reads it); every 3 s while first run
  // or nothing has answered, since no ping comes from a door.
  $effect(() => { void app.rev; void refreshSetup(); });
  $effect(() => {
    const t = setInterval(() => {
      if (firstRun || waiting) void refreshSetup();
    }, 3000);
    return () => clearInterval(t);
  });
  async function onPick(path: string): Promise<void> {
    pickingVault = true; setupEpoch++;
    if (setup) setup = { ...setup, pick: undefined };
    try {
      setup = await pickVault(path);
      if (setup?.pick) return;
    // The door hands the port to the engine (or the engine restarts on the
    // new vault): a second of nobody answering. Wait for it before the
    // views re-read, or they read the gap.
    for (let i = 0; i < 40; i++) {
      try {
        const s = await setupStatus();
        if (s) setup = s;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    app.rev++;
    } catch (e) {
      if (setup) setup = { ...setup, pick: { path, problem: e instanceof Error ? e.message : String(e) } };
    } finally { pickingVault = false; }
  }
  async function onConsent(enabled: boolean): Promise<void> {
    const saved = await telemetryState({ enabled });
    if (!saved) throw new Error("Sharing preferences unavailable.");
    sharing = saved;
  }
  async function onConnect(): Promise<void> {
    setup = await connectClaude();
    app.rev++;
  }
  async function onName(name: string, email?: string): Promise<void> {
    setup = await declareName(name, email);
    app.rev++;
  }

  $effect(() => { startUpdateChecks(); });

  $effect(() => {
    const names = { sharedVaultSettings: "Shared vaults", home: "Home", top: "Top", vault: "Vault", graph: "Graph", connectedClients: "Connected Clients", pilotSettings: "Pilot", integrations: "Integrations", agents: "Models", vaultSettings: "General", themes: "General", diagnostics: "Diagnostics", search: "Search", squad: "Squad" };
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

{#if waiting}
  <!-- nothing has answered yet: not the app, not first run — say so quietly -->
  <p class="waiting">Waiting for the engine…</p>
{:else if firstRun && setup}
  <FirstRun {setup} {onPick} {onConnect} {onName} {telemetryPending} {onConsent} />
{:else}
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
  {#if app.view === "integrations"}
    <IntegrationsView />
  {:else if app.view === "connectedClients"}
    <ConnectedClientsView />
  {:else if app.view === "pilotSettings"}
    <PilotSettingsView />
  {:else if app.view === "agents"}
    <AgentsView />
  {:else if app.view === "sharedVaultSettings"}
    <SharedVaultSettings />
  {:else if app.view === "vaultSettings"}
    <VaultSettingsView />
  {:else if app.view === "themes"}
    <VaultSettingsView />
  {:else if app.view === "diagnostics"}
    <DiagnosticsView />
  {:else if app.view === "squad"}
    <!-- loaded on demand: three.js stays out of every other screen's bundle -->
    {#await import("./components/SquadView.svelte") then m}<m.default />{/await}
  {/if}
</div>
{/if}

<style>
  .waiting { margin: 0; padding: 40vh var(--app-gutter) 0; text-align: center;
    font: var(--type-meta); color: var(--text-faint); }
</style>
