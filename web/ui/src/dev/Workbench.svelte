<script lang="ts">
  // THE WORKBENCH — a component and a fabricated state, with no vault, no
  // server and no queue behind it. Replaces the throwaway harness.html that
  // kept getting rebuilt and deleted (2026-08-06).
  //
  // Two controls beyond the scene picker, both earning their place: WIDTH,
  // because this table sizes to `max-content` and its interesting failures
  // are at the edges; and THEME, because tokens.css carries whole other
  // palettes — the dark toggle wears Dusk, the system's dark half — that
  // nothing else exercises.
  //
  // To add a component: give it scenes in fixtures.ts and add one entry to
  // COMPONENTS below.
  import AttentionWorkbench from "./AttentionWorkbench.svelte";
  import UnreadSourcesWorkbench from "./UnreadSourcesWorkbench.svelte";
  import PilotsPaneWorkbench from "./PilotsPaneWorkbench.svelte";
  import { PILOTS_PANE_SCENES } from "./pilotsPaneScenes";
  import { ATTENTION_SCENES } from "./attentionScenes";
  import { untrack } from "svelte";
  import { PERMISSIONS_SCENES } from "./permissionsScenes";
  import PilotSessionWorkbench from "./PilotSessionWorkbench.svelte";
  import PilotIdentityWorkbench from "./PilotIdentityWorkbench.svelte";
  import LogomarkWorkbench from "./LogomarkWorkbench.svelte";
  import LogomarkRender from "./LogomarkRender.svelte";
  import { LOGOMARK_SCENES } from "./logomarkScenes";
  import AgentIndicatorWorkbench from "./AgentIndicatorWorkbench.svelte";
  import AgentChatWorkbench from "./AgentChatWorkbench.svelte";
  import { AGENT_CHAT_SCENES } from "./agentChatScenes";
  import { PILOT_SESSION_SCENES } from "./pilotSessionScenes";
  import AppShell from "../components/AppShell.svelte";
  import DirectiveList from "../components/DirectiveList.svelte";
  import EntityFolds from "../components/EntityFolds.svelte";
  import FirstRun from "../components/FirstRun.svelte";
  import { EFFECT_PRESETS, type EffectPreset } from "../lib/graph/effects";
  import type { GraphViewState } from "../../../../lib/graphView";
  import LinkGraph from "../components/LinkGraph.svelte";
  import UpdateNudge from "../components/UpdateNudge.svelte";
  import { directivesFor } from "../lib/queueView";
  import { setupDone } from "../lib/setup";
  import type { GraphData, GraphNode } from "../lib/types";
  import { pilot } from "../lib/pilot.svelte";
  import { app, gotoNote } from "../lib/store.svelte";
  import { update } from "../lib/update.svelte";
  import { freshen, GRAPH_SCENES, GRAPH_SAMPLES, QUEUE_SCENES, UPDATE_SCENES, type UpdateScene } from "./fixtures";
  import { BRIEFINGS, DROP, DROP_PATH, FILED_BY, FIRST_RUN, INTEGRATIONS, PILOT, SETTINGS, installFakeApi, setVaultState, type VaultState } from "./fakeApi";
  import { FOLD_SCENES, type FoldScene } from "./foldFixtures";

  // THE WHOLE APP, on a fabricated vault (see fakeApi.ts). Installed once,
  // before anything mounts: fetch and EventSource are swapped, so the real
  // App runs against a world this file writes. State switches then go
  // through setVaultState + a rev bump — the same signal a live vault change
  // sends — so the app never remounts and keeps its route.
  // The browser's own fetch, kept from before the swap: what ?g= and ?t=
  // below reach the dev server with (and, through its proxy, the live
  // engine) — the fake answers every URL it is asked, 404 for the ones it
  // does not know.
  const realFetch = window.fetch.bind(window);
  installFakeApi();

  // The queue pair read the SAME scenes: a scene is a queue state, and these
  // are two views onto one. The note-side list just filters it to the
  // directives, as the note view's directives block did until 2026-09-06.
  // LinkGraph brings its own (fabricated constellations — see fixtures).
  const COMPONENTS = [
    { name: "unread sources", scenes: {
      "text-tab": { label: "Source text tab · read toggle", note: "Select a source, then mark it read or unread in the text tab. Opening alone does not change read state. All content and changes are simulated." },
      crowded: { label: "Crowded · unread sources", note: "The real graph renderer with unread-source breathing corners. Mock data only; selecting and marking read changes this preview." },
      many: { label: "Crowded · many unread", note: "Half the sources are unread: judge whether the repeated motion is too busy." },
      quiet: { label: "Crowded · all read", note: "No unread sources, no attention selectors." },
    } },
    { name: "pilots pane", scenes: PILOTS_PANE_SCENES },
    { name: "notifications", scenes: ATTENTION_SCENES },
    { name: "DirectiveList", scenes: QUEUE_SCENES },
    { name: "LinkGraph", scenes: GRAPH_SCENES },
    { name: "UpdateNudge", scenes: UPDATE_SCENES },
    { name: "first run", scenes: FIRST_RUN },
    { name: "filed by", scenes: FILED_BY },
    { name: "a drop", scenes: DROP },
    { name: "settings", scenes: SETTINGS },
    { name: "integrations", scenes: INTEGRATIONS },
    { name: "pilot", scenes: PILOT_SESSION_SCENES },
    { name: "agent chat", scenes: AGENT_CHAT_SCENES },
    { name: "permissions", scenes: PERMISSIONS_SCENES },
    { name: "pilot (legacy)", scenes: PILOT },
    { name: "entity folds", scenes: FOLD_SCENES },
    { name: "briefings", scenes: BRIEFINGS },
    { name: "logomark", scenes: LOGOMARK_SCENES },
  ];
  // the groups that mount the WHOLE App against fakeApi, not one component
  const APP_GROUPS = new Set(["first run", "intake on home", "filed by", "a drop", "settings", "integrations", "pilot (legacy)", "briefings"]);

  // The scene rides the query string (?c=<group>&s=<key>) so a state can be
  // linked to and screenshotted headlessly. The QUERY, not the hash: the
  // mounted App owns the hash (its router writes it on every navigation)
  // and would clobber anything the workbench kept there.
  const q = new URLSearchParams(location.search);
  const preview = q.get("preview") === "1";
  let fitWidth = $state(true);
  let showScenes = $state(false);
  const c0 = COMPONENTS.find((c) => c.name === (q.get("c") === "agents pane" ? "pilots pane" : q.get("c"))) ?? COMPONENTS[0];
  let componentName = $state(c0.name);
  let sceneKey = $state(q.get("s") && c0.scenes[q.get("s")!] ? q.get("s")! : Object.keys(c0.scenes)[0]);
  $effect(() => {
    const u = new URL(location.href);
    u.searchParams.set("c", componentName);
    u.searchParams.set("s", sceneKey);
    if (componentName === "LinkGraph") u.searchParams.set("sample", sampleKey);
    else u.searchParams.delete("sample");
    if (graphUrl) u.searchParams.set("g", graphUrl);
    else u.searchParams.delete("g");
    history.replaceState(history.state, "", u);
  });
  let width = $state(880);
  let dark = $state(q.get("sample") === "pilots");
  // ?g=<url> — a graph JSON of your own in place of the scene's (a whole
  // vault's /api/graph saved under web/ui/public/, say — never committed),
  // so the canvas can be judged at the size of a real vault, which no
  // fabricated scene is (2026-09-05: sixteen hundred nodes fused into one
  // white mass that six hubs and their fans never showed).
  let own = $state<GraphData | null>(null);
  const g = q.get("g");
  let graphUrl = $state(g ?? "");
  let graphLoading = $state(false);
  let graphError = $state("");
  let graphReload = $state(0);
  let litId = $state<string | null>(null);
  let graphView = $state<GraphViewState>({ selected: [], excluded: [] });
  let effects = $state<EffectPreset>('all');
  let reducedMotion = $state(false), pilotsActive = $state(true);
  let sampleKey = $state(GRAPH_SAMPLES[q.get("sample") ?? q.get("s") ?? ""] ? (q.get("sample") ?? q.get("s"))! : "small");
  $effect(() => { void sampleKey; litId = null; graphView = { selected: [], excluded: [] }; });
  $effect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => { reducedMotion = media.matches; };
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  });
  let rowsEl = $state<HTMLDivElement | null>(null);
  /** a dozen of the scene's nodes, spread across its degrees: hubs to
   * leaves, so both ends of the region rule are a hover away */
  const feedRows = (d: GraphData): GraphNode[] => {
    const byDeg = [...d.nodes].sort((a, b) => b.degree - a.degree);
    const n = Math.min(12, byDeg.length);
    return Array.from({ length: n }, (_, k) => byDeg[Math.floor((k * (byDeg.length - 1)) / Math.max(1, n - 1))]!);
  };
  function rowKey(e: KeyboardEvent, rows: GraphNode[]): void {
    const i = rows.findIndex((r) => r.id === litId);
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); litId = rows[Math.min(rows.length - 1, i + 1)]?.id ?? null; }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); litId = rows[Math.max(0, i - 1)]?.id ?? null; }
    else if (e.key === "Escape") litId = null;
  }

  // ── the drop, PLAYED (2026-09-06) ─────────────────────────────────────
  // The story is three vault states in a row under ONE mounted App — a
  // scene switch remounts, and the point of the story is what the camera
  // does BETWEEN the states: the landing's point turning at the centre,
  // then the flight out to the threads the round gave it. So play() writes
  // the states the way a live vault's changes arrive (setVaultState + a
  // rev bump) and opens the landing the way DropZone does (gotoNote).
  let playing = $state(false);
  let playTimer: ReturnType<typeof setTimeout> | undefined;
  const isDrop = $derived(componentName === "a drop");
  function play(): void {
    clearTimeout(playTimer);
    playing = true;
    setVaultState(DROP.before!); app.rev++; location.hash = "/";
    playTimer = setTimeout(() => {
      setVaultState(DROP.landed!); app.rev++; gotoNote(DROP_PATH);
      playTimer = setTimeout(() => { setVaultState(DROP.filed!); app.rev++; playing = false; }, 3000);
    }, 700);
  }
  $effect(() => { if (!isDrop) { clearTimeout(playTimer); playing = false; } });

  const component = $derived(COMPONENTS.find((c) => c.name === componentName)!);
  const raw = $derived(component.scenes[sceneKey] ?? Object.values(component.scenes)[0]);
  const isGraph = $derived(componentName === "LinkGraph");
  const isApp = $derived(APP_GROUPS.has(componentName) || (componentName === "permissions" && sceneKey === "settings"));
  const graph = $derived(isGraph ? GRAPH_SAMPLES[sampleKey]! : null);
  const previewGraph = $derived.by(() => {
    const data = own ?? graph?.data;
    if (!data || pilotsActive) return data;
    return { ...data, nodes: data.nodes.map(n => n.pilotPhase ? { ...n, pilotActive: false, pilotNeedsYou: false, pilotPhase: "idle" as const, live: undefined } : n) };
  });
  // Steps 1 and 2 of first run are not the App — they are the screen that
  // stands in for it until a vault and an agent both exist. A scene that
  // carries an unfinished setup mounts FirstRun alone; one that carries a
  // finished one, or none, mounts the App.
  const firstRun = $derived.by(() => {
    if (!isApp) return null;
    const s = (raw as VaultState).setup;
    return s && !setupDone(s) ? s : null;
  });

  // Swapping the world: point the stub at the new state, drop the cache, and
  // raise the revision every view watches. AppShell owns initialization;
  // the store keeps global subscriptions singular across scene remounts.
  //
  // untrack, or the effect eats itself: `app.rev++` READS app.rev to write
  // it, which makes the effect depend on the state it just changed. Only the
  // scene (`raw`) and the mode should re-run this.
  $effect(() => {
    if (!isApp) return;
    const state = raw as VaultState;
    untrack(() => {
      setVaultState(state);
      // the pilot's HUD phases are the store's, written here: no session can
      // exist behind fakeApi (a hold mints against its 401, which is the
      // error scene happening live)
      const p = state.pilot;
      pilot.open = !!p?.phase && !["off", "idle"].includes(p.phase);
      pilot.configured = p?.configured ?? false;
      pilot.phase = p?.phase ?? (p?.configured ? "idle" : "off");
      pilot.lines = p?.lines ?? [];
      pilot.live = p?.live ?? "";
      pilot.tools = p?.tools ?? [];
      pilot.error = p?.error ?? "";
      pilot.held = p?.phase === "listening" || p?.phase === "connecting";
      // the scene's screen, written before the App reads the hash on init
      // (and picked up by its hashchange listener after)
      location.hash = state.hash ?? `/${state.view ?? ""}`;
      app.rev++;
    });
  });
  // slid forward to now, so the workbench keeps showing the same-day time
  // format the app shows most of the time (see freshen). Queue scenes only —
  // a graph has no clock in it.
  const isNudge = $derived(componentName === "UpdateNudge");
  // the folds screen is a component with callbacks: the workbench answers
  // them with a log under the frame, since there is no record to write
  const isFolds = $derived(componentName === "entity folds");
  const folds = $derived(isFolds ? (raw as FoldScene) : null);
  let foldLog = $state<string[]>([]);
  $effect(() => { void sceneKey; foldLog = []; });
  // the nudge reads the real store (lib/update.svelte.ts) — a scene IS a
  // store state, written on pick, cleared when the group is left so the
  // banner does not follow into an app scene
  $effect(() => {
    if (isNudge) {
      const u = raw as UpdateScene;
      update.available = u.available;
      update.phase = u.phase;
      update.error = u.error;
    } else if (update.available) {
      update.available = null;
      update.phase = "idle";
      update.error = null;
    }
  });
  const scene = $derived(isGraph || isApp || isNudge || isFolds || componentName === "pilot" || componentName === "agent chat" || componentName === "notifications" || componentName === "permissions" || componentName === "logomark" ? null : freshen(raw as (typeof QUEUE_SCENES)[string]));
  const note = $derived((raw as { note: string }).note);

  // ?t=<data-theme> — a palette to judge the scene under beyond the dark
  // toggle: a built-in, or a skin of this machine's (?t=skin-solarized-light). The dev
  // proxy reaches the live engine's /api/themes, so a file in
  // ~/.config/bigbrain/themes/ can be looked at against a fabricated scene;
  // its CSS goes in as one style element, the way lib/theme.ts installs it.
  const themeParam = q.get("t");
  const wear = (): void => {
    const root = document.documentElement;
    if (dark) root.setAttribute("data-theme", "dusk");
    else if (themeParam) root.setAttribute("data-theme", themeParam);
    else root.removeAttribute("data-theme");
  };
  $effect(wear);
  const skinOn: Promise<void> = themeParam?.startsWith("skin-")
    ? realFetch("/api/themes").then((r) => r.json()).then((rep: { css: string }) => {
        const el = document.createElement("style");
        el.textContent = rep.css;
        document.head.appendChild(el);
      }).catch(() => { /* no engine behind the proxy: the param wears nothing */ })
    : Promise.resolve();
  // the palette before the picture: the canvas resolves its colours once,
  // at build, and a graph built before the skin landed wears the default's
  $effect(() => {
    const url = graphUrl;
    void graphReload;
    own = null; graphError = ""; graphLoading = !!url;
    litId = null;
    if (!url) return;
    const controller = new AbortController();
    void skinOn.then(() => realFetch(url, { signal: controller.signal }))
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json() as GraphData;
        if (!Array.isArray(d?.nodes) || !Array.isArray(d?.edges) || typeof d.hash !== "string") throw new Error("Invalid graph response");
        if (!controller.signal.aborted) own = d;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) graphError = `Could not load the graph (${error instanceof Error ? error.message : "connection failed"}). Showing the sample; check that the local BigBrain engine is running.`;
      })
      .finally(() => { if (!controller.signal.aborted) graphLoading = false; });
    return () => controller.abort();
  });
</script>

<div class="wb" class:preview class:show-scenes={showScenes}>
  {#if preview && isGraph && (sampleKey === "pilots" || q.get("pilots") === "1")}
    <div class="pilot-preview-controls">
      <label><input type="checkbox" bind:checked={pilotsActive} /> Pilots active</label>
    </div>
  {/if}
  <aside>
    <h1>workbench</h1>
    {#if isDrop}
      <!-- the three states in a row, under the mounted app: the camera's
           moves between them are the thing to watch. At the TOP of the
           column: the app's text tab is fixed to the window's bottom and
           rides over the column's foot. -->
      <button class="scene play" onclick={play} disabled={playing}>{playing ? "playing…" : "▶ play the drop"}</button>
    {/if}
    {#each COMPONENTS as c (c.name)}
      <h2>{c.name}</h2>
      {#each Object.entries(c.scenes) as [key, s] (key)}
        <button class="scene" class:on={componentName === c.name && sceneKey === key}
          onclick={() => { componentName = c.name; sceneKey = key; showScenes = false; }}>{s.label}</button>
      {/each}
    {/each}

    <h2>viewport</h2>
    <label class="ctl"><input type="checkbox" bind:checked={fitWidth} /> Fit available width</label>
    <input aria-label="Preview width" type="range" min="320" max="1400" step="20" bind:value={width} disabled={fitWidth} />
    <div class="ctl"><code>{width}px</code>
      <label><input type="checkbox" bind:checked={dark} /> dark</label>
    </div>

    {#if isGraph}
      <h2>select a neighborhood — click, or ↑↓</h2>
      <!-- the home screen's list, reduced to what LinkGraph sees of it: a
           row under the pointer or the cursor is one lit node -->
      <div class="rows" role="listbox" tabindex="0" aria-label="Rows standing in for the feed"
        bind:this={rowsEl} onkeydown={(e) => rowKey(e, feedRows(own ?? graph!.data))}>
        {#each feedRows(own ?? graph!.data) as r (r.id)}
          <div class="row" class:on={litId === r.id} role="option" aria-selected={litId === r.id} tabindex={-1}
            onclick={() => (litId = r.id)}
            onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); litId = r.id; } }}>
            <span class="deg">{r.degree}</span>{r.title}
          </div>
        {/each}
      </div>
    {/if}
  </aside>

  <main>
    {#if !preview}
      <div class="preview-controls">
        <button class="scene scene-toggle" onclick={() => { showScenes = !showScenes; }}>{showScenes ? "Close scenes" : "Scenes"}</button>
        <a href={`?c=${encodeURIComponent(componentName)}&s=${encodeURIComponent(sceneKey)}&preview=1${graphUrl ? `&g=${encodeURIComponent(graphUrl)}` : ""}&sample=${encodeURIComponent(sampleKey)}${location.hash}`}>Open full-window preview ↗</a>
      </div>
      <p class="note">{note}</p>
    {/if}
    {#if isGraph}
      <div class="tracer-controls">
        <div class="tracer-actions">
          <label>Graph
            <select aria-label="Graph source" bind:value={graphUrl}>
              <option value="">Small sample</option>
              <option value="/api/graph">My graph</option>
              {#if g && g !== "/api/graph"}<option value={g}>Custom graph</option>{/if}
            </select>
          </label>
          {#if !graphUrl}
            <label>Sample
              <select aria-label="Sample shape" bind:value={sampleKey}>
                {#each Object.entries(GRAPH_SAMPLES) as [key, sample]}
                  <option value={key}>{sample.label}</option>
                {/each}
              </select>
            </label>
          {/if}
          <span role="status">{graphLoading ? "Loading your graph…" : `${(own ?? graph!.data).nodes.length.toLocaleString()} nodes · ${(own ?? graph!.data).edges.length.toLocaleString()} edges`}</span>
          {#if graphUrl}<button class="scene" onclick={() => graphReload++} disabled={graphLoading}>Reload graph</button>{/if}
        </div>
        {#if graphError}<p class="motion-note" role="alert">{graphError}</p>{/if}
        <div class="tracer-actions">
          <label>Neighborhood
            <select aria-label="Selected neighborhood" value={litId ?? ""} onchange={(e) => (litId = e.currentTarget.value || null)} disabled={graphLoading}>
              <option value="">Choose a node…</option>
              {#each (own ?? graph!.data).nodes as node (node.id)}
                <option value={node.id}>{node.title} ({node.degree} links)</option>
              {/each}
            </select>
          </label>
          <button class="scene" onclick={() => (litId = null)} disabled={!litId}>Clear selection</button>
        </div>
        <label>Effects <select bind:value={effects}>{#each EFFECT_PRESETS as value}<option {value}>{value}</option>{/each}</select></label>
        <label><input type="checkbox" bind:checked={pilotsActive} /> Active agents</label>
        <p class="motion-note">Shift-click adds a neighborhood. Ctrl-click excludes a node. Escape restores home.</p>
        {#if reducedMotion}<p class="motion-note">Reduced motion is enabled.</p>{/if}
      </div>
    {/if}
    <!-- the frame is the viewport under test; the component gets nothing
         from it but a width, exactly as the real page gives it -->
    {#if isFolds && foldLog.length}
      <!-- what the owner would have written: one line per accept / reject -->
      <pre class="log">{foldLog.join("\n")}</pre>
    {/if}
    <div class="frame" style:width={fitWidth || preview ? "100%" : `${width}px`}>
      {#if componentName === "agent chat"}
        {#key sceneKey}<div class="stage pilot-stage"><AgentChatWorkbench scene={sceneKey} /></div>{/key}
      {:else if componentName === "pilot"}
        {#key sceneKey}<div class="stage pilot-stage">{#if sceneKey === "agents"}<AgentIndicatorWorkbench />{:else if sceneKey === "identity"}<PilotIdentityWorkbench />{:else}<PilotSessionWorkbench scene={sceneKey} />{/if}</div>{/key}
      {:else if componentName === "unread sources"}
        {#key sceneKey}<div class="stage pilot-stage"><UnreadSourcesWorkbench scene={sceneKey} /></div>{/key}
      {:else if componentName === "pilots pane"}
        {#key sceneKey}<div class="stage pilot-stage"><PilotsPaneWorkbench scene={sceneKey} /></div>{/key}
      {:else if componentName === "logomark"}
        {#key sceneKey}<div class="stage pilot-stage">{#if sceneKey === "render"}<LogomarkRender />{:else}<LogomarkWorkbench scene={sceneKey} />{/if}</div>{/key}
      {:else if componentName === "notifications"}
        {#key sceneKey}<div class="stage pilot-stage"><AttentionWorkbench scene={sceneKey} /></div>{/key}
      {:else if componentName === "DirectiveList" && scene}
        <DirectiveList rows={directivesFor(scene.messages)} />
      {:else if isNudge}
        <UpdateNudge />
      {:else if folds}
        {#key sceneKey}
          <div class="page">
            <EntityFolds groups={folds.groups}
              onaccept={(c, others) => { foldLog = [`alias ${others.map((m) => `"${m.label}"`).join(", ")} → ${c.id} "${c.label}"`, ...foldLog]; }}
              onreject={(m, others) => { foldLog = [`reject "${m.label}" ≠ ${others.map((o) => `"${o.label}"`).join(", ")}`, ...foldLog]; }} />
          </div>
        {/key}
      {:else if graph}
        <!-- LinkGraph fills its parent absolutely, so the frame has to be a
             positioned box with a height of its own — the app gives it the
             page, and here it gets 60vh of it. A different dataset gets a
             fresh camera fit, even after dragging or zooming the sample. -->
        <output class="graph-state" aria-label="Graph view state">{JSON.stringify(graphView)}</output>
        {#key `${sceneKey}:${own?.hash ?? graph.data.hash}`}
          <div class="stage"><LinkGraph data={previewGraph ?? null} {effects} controls={!preview} bind:viewState={graphView}
            selected={litId} onselect={id => litId = id} /></div>
        {/key}
      {:else if firstRun}
        {#key sceneKey}
          <div class="stage app"><FirstRun setup={firstRun} /></div>
        {/key}
      {:else if isApp}
        <!-- The real App. #main sizes to the viewport, so the stage has to
             give it a page-shaped box of its own.

             KEYED on the scene: a switch here means a different vault owned
             by a different person, which in production is only ever reached
             by a page load. Components are entitled to ask a question once
             per mount for anything that cannot change under a live page — so
             a scene switch that did NOT remount left them answering about
             the previous scene's vault. AppShell calls the idempotent store initializer, so the
             EventSource and hash listeners stay singular across remounts. -->
        {#key sceneKey}
          <div class="stage app"><AppShell /></div>
        {/key}
      {/if}
    </div>
  </main>
</div>

<style>
  /* app.css pins body to 100vh with overflow hidden (the app scrolls its
     own views), so the page never scrolls — each column here has to be
     its own scroll box or the scene list is simply cut off. */
  .wb { display: grid; grid-template-columns: 220px minmax(0, 1fr); height: 100dvh;
    background: var(--bg); color: var(--text); }
  /* above the app's ground: a mounted App fixes its graph canvas to the
     WINDOW (HomeView), and painted after this column it would take every
     click meant for a scene button (2026-09-06) */
  aside { position: relative; z-index: 3; background: var(--bg);
    border-right: 1px solid var(--ink-050); padding: 20px 16px; display: flex;
    flex-direction: column; gap: 6px; align-items: stretch; min-height: 0; overflow-y: auto;
    /* app.css hides every scrollbar; the scene list is long, so show a thin one */
    scrollbar-width: thin; }
  aside::-webkit-scrollbar { width: 6px; }
  aside::-webkit-scrollbar-thumb { background: var(--ink-200); border-radius: 3px; }
  h1 { font: var(--type-eyebrow); letter-spacing: var(--ls-eyebrow); text-transform: uppercase;
    color: var(--text-faint); margin: 0 0 10px; }
  h2 { font: var(--type-meta); color: var(--text-faint); margin: 16px 0 4px; }
  .scene { font: var(--type-chip); text-align: left; background: none; border: 0; cursor: pointer;
    color: var(--text); padding: 7px 9px; border-radius: var(--r-sm); }
  .scene:hover { background: var(--well); }
  .scene.on { background: var(--well); color: var(--text-strong); font-weight: 600; }
  .scene.play { color: var(--text-strong); font-weight: 600; }
  .scene.play:disabled { color: var(--text-faint); cursor: default; }
  .ctl { display: flex; justify-content: space-between; align-items: center;
    font: var(--type-meta); color: var(--text-muted); }
  .rows { display: flex; flex-direction: column; border-radius: var(--r-sm); outline: none; }
  .rows:focus-visible { box-shadow: 0 0 0 1px var(--accent-1); }
  .row { font: var(--type-chip); color: var(--text); padding: 5px 9px; border-radius: var(--r-sm);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: default; }
  .row.on { background: var(--well); color: var(--text-strong); }
  .deg { display: inline-block; width: 2.2em; color: var(--text-faint); font: var(--type-mono); }
  main { padding: 20px; overflow: auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .preview-controls { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-bottom: 12px; font: var(--type-meta); }
  .preview-controls a { color: var(--text-muted); }
  .scene-toggle { display: none; }
  .note { font: var(--type-meta); color: var(--text-muted); max-width: 62ch;
    margin: 0 0 22px; line-height: 1.55; }
  .tracer-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px;
    margin-bottom: 28px; max-width: 880px; font: var(--type-meta); color: var(--text-muted); }
  .tracer-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; flex-basis: 100%; }
  .tracer-controls > label { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; }
  .motion-note { flex-basis: 100%; margin: 0; }
  /* a hairline so the frame's edges are visible — this is the width the
     component is being asked to live in */
  .frame { outline: 1px dashed var(--ink-050); outline-offset: 1px; max-width: 100%; min-width: 0; min-height: 0; flex: 1; }
  .stage { position: relative; height: 60vh; min-height: 380px; }
  /* a settings-card-shaped page for a component that is one */
  .page { padding: var(--sp-6) var(--sp-7); }
  .log { font: var(--type-mono); color: var(--text-note); background: var(--well);
    padding: 10px 12px; border-radius: var(--r-sm); margin: 0 0 18px; white-space: pre-wrap; }
  /* the app draws its own full-height column; give it one and let it own it */
  /* Fixed app furniture belongs to this preview, not the browser window.
     Container units also make the drawer follow the simulated viewport. */
  .stage.app { height: 100%; min-height: 0; overflow: hidden; transform: translateZ(0); container-type: size; }
  .stage.app :global(.drawer), .stage.app :global(.pilot-view) { width: min(calc(100cqw - 2 * var(--app-gutter)), var(--app-max)); }
  .stage.app :global(.drawer) { height: min(30cqh, 280px); }
  @container (max-width: 640px) { .stage.app :global(.drawer) { height: min(44cqh, 360px); } }
  .stage.app :global(#main) { --app-gutter: clamp(12px, 3cqw, 34px); }
  .stage.app :global(#main) { height: 100%; }
  .stage.app :global(.fr) { height: 100%; }
  .pilot-preview-controls { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 10; display: flex; gap: 20px; align-items: center; padding: 12px 18px; border: 1px solid var(--text-muted); border-radius: 10px; background: var(--bg); color: var(--text-strong); font: var(--type-meta); }
  .pilot-preview-controls label { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .wb.preview { grid-template-columns: minmax(0, 1fr); }
  .preview aside { display: none; }
  .preview main { padding: 0; overflow: hidden; }
  .preview .frame { outline: none; }
  .preview .tracer-controls { display: none; }
  .preview .stage:not(.app) { height: 100vh; }
  .stage.pilot-stage { height: calc(100dvh - 120px); min-height: 540px; }
  .preview .graph-state { position: absolute; bottom: 8px; right: 8px; z-index: 1; font: 10px var(--font-mono); color: var(--text-muted); pointer-events: none; }
  @media (max-width: 720px) {
    .wb { grid-template-columns: minmax(0, 1fr); }
    aside { display: none; }
    .show-scenes aside { display: flex; position: fixed; inset: 56px auto 0 0; width: min(280px, 85vw); z-index: 20; }
    .scene-toggle { display: block; margin-right: auto; }
    main { padding: 12px; }
    .note { margin-bottom: 12px; }
  }
</style>
