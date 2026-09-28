<script lang="ts">
  import PilotMentionComposer from "../components/PilotMentionComposer.svelte";
  import { MENTION_RECENTS, mentionText, mentionGlyph, type MentionPart } from "./pilotMentions";
  import NodeIndicator from "../components/NodeIndicator.svelte";
  import { tooltip } from "../lib/tooltip";
  import { onMount, tick, untrack } from "svelte";
  import { SELECTOR_RATIO } from "./pilotSessionScenes";

  const { scene = "overview" }: { scene?: string } = $props();
  type Phase = "draft" | "working" | "answered" | "interrupted";
  type Point = { id: string; title: string; x: number; y: number; r: number };
  type Turn = { parts?: MentionPart[]; role: "user" | "assistant"; text: string; links?: string[] };
  type Session = Point & { mentionParts?: MentionPart[]; dormant?: boolean; phase: Phase; context: string[]; seed: string[]; draft: string; turns: Turn[]; created: string };
  const question = "who maintains the Arbor export tools";
  const answer = "Morgan Ellis maintains the export formatter, Dana Reed builds sample datasets, and Alex Rowan reviews the documentation. The editor and cloud tool share the same table format.";
  const nodes: Point[] = [
    { id: "dana", title: "Dana Reed", x: 525, y: 450, r: 8 },
    { id: "alex", title: "Alex Rowan", x: 325, y: 325, r: 7 },
    { id: "air", title: "Arbor Cloud", x: 492, y: 222, r: 7 },
    { id: "morgan", title: "Morgan Ellis", x: 635, y: 267, r: 7 },
    { id: "arbor", title: "Arbor OS", x: 821, y: 205, r: 7 },
    { id: "note", title: "Arbor collaborators", x: 875, y: 440, r: 7 },
  ];
  const background = Array.from({ length: 100 }, (_, i) => {
    const angle = i * 2.39996323;
    const distance = 190 + ((i * 79) % 450);
    return { id: `background-${i}`, x: 525 + Math.cos(angle) * distance * 1.2,
      y: 450 + Math.sin(angle) * distance, r: 2.4 + (i % 9 === 0 ? 5 : i % 4) };
  });
  let sessions = $state<Session[]>([]);
  let activeId = $state<string | null>(null);
  let selection = $state<string[]>([]);
  let panelOpen = $state(false);
  let selectorRatio = $state(SELECTOR_RATIO);
  let showContext = $state(false);
  let showTuning = $state(false);
  let search = $state("");
  let composer = $state<HTMLTextAreaElement>();
  let mentionComposer = $state<PilotMentionComposer>();
  let expanded = $state(false);
  let panel = $state<HTMLElement>();
  let heightAnimation: Animation | undefined;
  let resizeRevision = 0;
  const experiment = $derived(scene === "mentions" || scene === "resize");
  let transcript = $state<HTMLDivElement>();
  let camera = $state({ x: 0, y: 0, scale: 1 });
  let serial = 0;
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  const active = $derived(sessions.find(s => s.id === activeId));
  const attached = $derived(active?.context ?? selection);
  const shown = $derived(new Set(attached));
  const contextLabel = $derived.by(() => {
    if (!attached.length) return "";
    const original = active?.seed.length === 1 ? active.seed[0] : undefined;
    if (original && attached.includes(original)) {
      return attached.length === 1 ? title(original) : `${title(original)} + ${attached.length - 1} selected`;
    }
    return `${attached.length} selected`;
  });

  function title(id: string): string { return [...nodes, ...sessions].find(n => n.id === id)?.title ?? id; }
  function cancelTimers(id: string): void { for (const timer of timers.get(id) ?? []) clearTimeout(timer); timers.delete(id); }
  function focusComposer(): void { void tick().then(() => { if (experiment) mentionComposer?.focus(); else composer?.focus(); }); }
  function flyTo(s?: Point): void {
    camera = s ? { x: 650 - s.x * 1.12, y: 320 - s.y * 1.12, scale: 1.12 } : { x: 0, y: 0, scale: 1 };
  }
  function start(context = [...selection]): void {
    if (active) return;
    const points = nodes.filter(n => context.includes(n.id));
    const origin = points.length ? { x: points.reduce((v, n) => v + n.x, 0) / points.length, y: points.reduce((v, n) => v + n.y, 0) / points.length } : { x: 500, y: 440 };
    const s: Session = { id: `pilot-${++serial}`, title: "New session", x: origin.x + 115 + (serial - 1) * 36,
      y: origin.y - 125, r: 9, phase: "draft", context: [...context], seed: [...context], draft: "", turns: [],
      created: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
    sessions.push(s); activeId = s.id; selection = [s.id]; panelOpen = true; showContext = false;
    flyTo(s); focusComposer();
  }
  function selectNode(id: string, additive = false): void {
    const session = sessions.find(s => s.id === id);
    if (session && !additive) {
      if (id !== activeId) leaveDraft();
      session.dormant = false; activeId = id; selection = [id]; panelOpen = true; flyTo(session); focusComposer();
    } else {
      const prior = active ? [...active.context] : selection;
      leaveDraft();
      selection = additive ? (prior.includes(id) ? prior.filter(n => n !== id) : [...prior, id]) : [id];
      activeId = null; panelOpen = false; flyTo();
    }
  }
  function leaveDraft(): void {
    const s = active;
    if (s?.phase !== "draft") return;
    if (s.draft.trim()) s.title = "Draft session";
    else sessions = sessions.filter(n => n.id !== s.id);
  }
  function updateContext(s: Session, context: string[]): void {
    s.context = [...new Set(context)];
    const points = nodes.filter(n => s.context.includes(n.id));
    if (points.length) {
      s.x = points.reduce((sum, n) => sum + n.x, 0) / points.length + 90;
      s.y = points.reduce((sum, n) => sum + n.y, 0) / points.length - 45;
      if (activeId === s.id) flyTo(s);
    }
  }
  function send(): void {
    const s = active;
    if (!s || s.phase === "working" || !s.draft.trim()) return;
    const message = s.draft.trim();
    const first = !s.turns.length;
    s.turns.push({ role: "user", text: message, parts: s.mentionParts }); mentionComposer?.clear(); s.mentionParts = []; s.draft = ""; s.phase = "working";
    const arbor = /arbor|dana|morgan/i.test(message);
    const summarizing = /summari|note/i.test(message);
    cancelTimers(s.id);
    timers.set(s.id, [setTimeout(() => {
      if (first) s.title = arbor ? "Dana × Arbor" : message.slice(0, 38);
      if (arbor) updateContext(s, [...s.context, "dana", "morgan", "arbor", "air"]);
    }, 900), setTimeout(() => {
      // A scripted second turn demonstrates replacement, including removal.
      if (summarizing) updateContext(s, ["dana", "arbor", "air", "note"]);
      else if (arbor) updateContext(s, [...s.context, "alex"]);
      s.turns.push({ role: "assistant", text: summarizing
        ? "Here’s the outline for a Arbor collaborators note: Dana and Morgan’s work on Arbor OS, followed by their Arbor Cloud discussion. The view now includes the note and its source threads."
        : arbor ? answer : "This is a scripted workbench reply. Your session keeps its own context and conversation; send another message to try a second turn.",
        links: summarizing ? ["note", "arbor", "air"] : arbor ? ["morgan", "arbor", "air"] : [] });
      s.phase = "answered"; timers.delete(s.id);
      if (activeId === s.id && panelOpen) focusComposer();
    }, 4200)]);
    focusComposer();
  }
  function closePilot(): void {
    const s = active; if (!s) return;
    cancelTimers(s.id); if (s.phase === "working") s.phase = "interrupted";
    s.dormant = true; selection = []; activeId = null; panelOpen = false;
    showContext = false; composer?.blur(); flyTo();
  }
  function shiftEscape(): void {
    if (active?.phase === "working") { cancelTimers(active.id); active.phase = "interrupted"; }
    else closePilot();
  }
  function escape(): void {
    if (showTuning || showContext) { showTuning = showContext = false; return; }
    if (active && panelOpen) {
      selection = []; leaveDraft(); activeId = null; flyTo();
      panelOpen = false; composer?.blur(); return;
    }
    activeId = null; selection = []; flyTo();
  }
  async function resizePanel(direction: number): Promise<void> {
    const next = direction > 0;
    if (!panel || expanded === next) return;
    const from = panel.getBoundingClientRect().height;
    heightAnimation?.cancel();
    const revision = ++resizeRevision;
    expanded = next;
    await tick();
    if (!panel || revision !== resizeRevision) return;
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const to = panel.getBoundingClientRect().height;
      heightAnimation = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: 260, easing: "cubic-bezier(.22, 1, .36, 1)",
      });
      try { await heightAnimation.finished; } catch { /* Reversed or closed. */ }
    }
    if (revision === resizeRevision && !expanded && transcript) transcript.scrollTop = transcript.scrollHeight;
  }
  function keydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const editable = target.matches("input, textarea, [contenteditable=true]");
    if (experiment && panelOpen && e.shiftKey && ["ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault(); resizePanel(e.key === "ArrowUp" ? 1 : -1); return;
    }
    if (e.key === "Escape") { e.preventDefault(); if (!e.repeat) { if (e.shiftKey && active) shiftEscape(); else escape(); } }
    else if (e.key === "Enter" && e.shiftKey && !editable && !active) { e.preventDefault(); if (!e.repeat) start(); }
  }
  // Clip every edge at the outer selector, including at both selected ends.
  function edge(a: Point, b: Point, aRadius: number, bRadius: number): string {
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
    return `M ${a.x + dx / length * aRadius} ${a.y + dy / length * aRadius} L ${b.x - dx / length * bRadius} ${b.y - dy / length * bRadius}`;
  }
  function radius(n: Point): number { return n.r * (shown.has(n.id) || selection.includes(n.id) ? selectorRatio : 1); }
  function linkedText(turn: Turn): { text: string; id?: string }[] {
    const links = nodes.filter(n => turn.links?.includes(n.id));
    const pattern = links.map(n => n.title).join("|");
    if (!pattern) return [{ text: turn.text }];
    return turn.text.split(new RegExp(`(${pattern})`, "g")).map(text => ({ text, id: links.find(n => n.title === text)?.id }));
  }
  onMount(() => {
    selection = scene === "alone" ? [] : scene === "multiple" ? ["dana", "arbor", "air"] : ["dana"];
    if (["draft", "typing", "working", "answered", "multiple", "alone", "mentions", "resize"].includes(scene)) {
      start();
      const s = sessions[0];
      if (scene === "typing") s.draft = question;
      if (scene === "working" || scene === "answered" || experiment) {
        s.title = "Dana × Arbor"; s.phase = scene === "working" ? "working" : "answered"; s.context = ["dana", "alex", "air", "morgan", "arbor"];
        s.turns = [{ role: "user", text: question }];
        if (scene !== "working") s.turns.push({ role: "assistant", text: answer, links: ["morgan", "arbor", "air"] });
      }
    }
    if (scene === "mentions") {
      sessions[0].draft = "Compare @";
      sessions[0].mentionParts = [{ text: "Compare @" }];
    }
    if (scene === "resize") {
      sessions[0].turns.push({ role: "user", text: "What should we cover next?" }, { role: "assistant", text: "Start with the table-format guide, then check how Arbor OS and Arbor Cloud expose their download buttons.\n\nMorgan maintains the formatter, Dana supplies the sample tables, and Alex checks the instructions. Empty cells and header-only exports need separate examples.\n\nA short maintenance note can connect the component owners to those examples." });
    }
    return () => { heightAnimation?.cancel(); for (const id of timers.keys()) cancelTimers(id); };
  });
  $effect(() => { void active?.turns.length; void tick().then(() => { if (transcript) transcript.scrollTop = transcript.scrollHeight; }); });
</script>

{#snippet indicator(phase: Phase | "idle", selected = true)}
  <NodeIndicator state={phase} {selected} size={48} ratio={selectorRatio} />
{/snippet}

<svelte:window onkeydown={keydown} />

<section class="pilot-workbench" aria-label="Pilot session prototype" data-phase={active?.phase ?? "graph"}>
  <div class="search-row">
    <label class="search"><svg width="25" height="25" viewBox="0 0 26 26" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="9" /><path d="m18 18 6 6" /></svg><input aria-label="Search graph" placeholder="search everything…" bind:value={search} /><kbd>/</kbd></label>
    <button class="settings" aria-label="Visual settings" onclick={() => showTuning = !showTuning}>⌘,</button>
  </div>
  {#if search.trim()}
    <div class="search-results">{#each nodes.filter(n => n.title.toLowerCase().includes(search.toLowerCase())) as n}<button onclick={() => { selectNode(n.id); search = ""; }}>{n.title}</button>{:else}<span>No matching nodes</span>{/each}</div>
  {/if}
  <div class="view-bar">
    {#if active}<strong>Pilot view</strong><span>{active.title !== "New session" ? active.title : ""}</span>{/if}
    {#if !active}<span>{attached.length ? `${attached.length} selected` : "No selection"}</span>{/if}
    {#if !active}<button class="new-session" onclick={() => start()}>⇧↵ New session</button>{/if}
  </div>
  {#if showTuning}<div class="tuning"><label>Selector ratio <output>{selectorRatio.toFixed(3)}</output><input aria-label="Selector ratio" type="range" min="1.1" max="2.5" step="0.01" bind:value={selectorRatio} /></label><button onclick={() => selectorRatio = SELECTOR_RATIO}>Reset to φ · 1.618</button></div>{/if}

  <svg class="graph" viewBox="0 0 1200 820" aria-label="Session graph">
    <g class="camera" style:transform={`translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`}>
      {#if !active || attached.length > 0}
      <g class="background" class:dimmed={!!active}>
        {#each background as n, i}
          <path d={edge(nodes[0], { ...n, title: "" }, radius(nodes[0]), n.r)} />
          {#if i % 3 === 0}<path d={`M ${n.x} ${n.y} L ${background[(i + 13) % background.length].x} ${background[(i + 13) % background.length].y}`} />{/if}
          <circle cx={n.x} cy={n.y} r={n.r} />
        {/each}
      </g>
      {#each nodes.slice(1) as n}
        {#if n.id !== "note" || shown.has("note")}
          <path class="relation" class:lit={shown.has(n.id)} d={edge(nodes[0], n, radius(nodes[0]), radius(n))} />
        {/if}
      {/each}
      {/if}
      {#each sessions as s (s.id)}
        <g class:inactive={s.id !== activeId}>
          {#each s.context as id (id)}
            {@const n = [...nodes, ...sessions].find(n => n.id === id)}
            {#if n}<path class="session-edge" class:flow={!s.dormant} class:dormant={s.dormant} data-from={id} data-to={s.id} d={edge(n, s, radius(n), s.r * selectorRatio)} />{/if}
          {/each}
        </g>
      {/each}
      {#each !active || attached.length > 0 ? nodes : [] as n}
        {#if n.id !== "note" || shown.has("note")}
          <g class="node" class:muted={!!active && !shown.has(n.id)} role="button" tabindex="0" aria-label={n.title} aria-pressed={shown.has(n.id)}
            onclick={(e) => selectNode(n.id, e.shiftKey)} onkeydown={(e) => { if (e.key === "Enter" && !e.shiftKey || e.key === " ") { e.preventDefault(); selectNode(n.id, e.shiftKey); } }}>
            <circle class="hit" cx={n.x} cy={n.y} r="22" />
            {#if shown.has(n.id)}<circle class="node-selector" cx={n.x} cy={n.y} r={n.r * selectorRatio} />{/if}
            <circle class="node-core" class:hollow={shown.has(n.id)} cx={n.x} cy={n.y} r={n.r} />
            <text x={n.x} y={n.y + n.r * selectorRatio + 19}>{n.title}</text>
          </g>
        {/if}
      {/each}
      {#each sessions as s (s.id)}
        <g class="session-node" class:dormant={s.dormant} role="button" tabindex="0" aria-label={`Pilot session: ${s.title}`} aria-pressed={activeId === s.id}
          onclick={() => selectNode(s.id)} onkeydown={(e) => { if (e.key === "Enter" && !e.shiftKey || e.key === " ") { e.preventDefault(); selectNode(s.id); } }}>
          <circle class="hit" cx={s.x} cy={s.y} r="25" />
          <g transform={`translate(${s.x - 24}, ${s.y - 24})`}>{@render indicator(s.dormant ? "idle" : s.phase, s.id === activeId)}</g>
          <text class="session-title" x={s.x} y={s.y + s.r * selectorRatio + 22}>{s.title}</text>
          {#if !s.dormant && s.phase === "draft" && s.draft}<text class="draft-mirror" x={s.x} y={s.y + s.r * selectorRatio + 42}>{s.draft.length > 65 ? `${s.draft.slice(0, 65)}…` : s.draft}</text>{/if}
        </g>
      {/each}
    </g>
  </svg>

  {#if active && panelOpen}
    <section bind:this={panel} class="composer-panel" class:experiment class:expanded class:has-turns={active.turns.length > 0} aria-label="Pilot conversation">
      <header>
        <span class="header-indicator">{@render indicator(active.phase, false)}</span>
        <strong>{active.title}</strong>
        <span class="status" role="status">{active.phase === "working" ? "Working" : active.phase === "interrupted" ? "Interrupted" : active.phase === "answered" ? active.created : ""}</span>
        {#if contextLabel}<button class="context" onclick={() => showContext = !showContext} aria-expanded={showContext}>Context · {contextLabel}</button>{/if}
        <div class="commands">
          {#if experiment}
            <div class="resize-controls">
            <button class="icon-command" aria-label="Standard text tab" aria-pressed={!expanded} aria-keyshortcuts="Shift+ArrowDown" use:tooltip={"Standard height (Shift-↓)"} onclick={() => resizePanel(-1)}><svg viewBox="0 0 14 14" aria-hidden="true"><path d="m3 5 4 4 4-4" /></svg></button>
            <button class="icon-command" aria-label="Expand text tab" aria-pressed={expanded} aria-keyshortcuts="Shift+ArrowUp" use:tooltip={"Expand text tab (Shift-↑)"} onclick={() => resizePanel(1)}><svg viewBox="0 0 14 14" aria-hidden="true"><path d="m3 9 4-4 4 4" /></svg></button>
            </div>
          {/if}
          {#if active.phase !== "working"}<button onclick={send} disabled={!active.draft.trim()}>↵ Send</button>{/if}
          <button onclick={escape}>Esc {active.phase === "draft" && !active.draft.trim() ? "Cancel" : "Back to graph"}</button>
          {#if active.phase === "working"}<button onclick={shiftEscape} aria-keyshortcuts="Shift+Escape">⇧Esc Interrupt</button>{/if}
          <button class="icon-command close-pilot" onclick={closePilot} aria-label="Stop" aria-keyshortcuts={active.phase === "working" ? undefined : "Shift+Escape"} use:tooltip={active.phase === "working" ? "Stop" : "Stop (Shift-Esc)"}><svg viewBox="0 0 14 14" aria-hidden="true"><path d="m3 3 8 8m0-8-8 8" /></svg></button>
        </div>
      </header>
      {#if showContext}
        <div class="context-items">{#each attached as id}<span>{title(id)}<button aria-label={`Remove ${title(id)} from context`} onclick={() => { if (active) updateContext(active, active.context.filter(n => n !== id)); }}>×</button></span>{:else}<span>This session has no attached items.</span>{/each}</div>
      {/if}
      {#if active.turns.length}
        <div class="transcript" bind:this={transcript} role="log" aria-label="Pilot messages" aria-live="polite">
          {#each active.turns as turn}<p class:user={turn.role === "user"}>{#if turn.parts?.length}{#each turn.parts as part}{#if "mention" in part}<span class="sent-mention"><span aria-hidden="true">{mentionGlyph(part.mention)}</span> {part.mention.title}</span>{:else}{part.text}{/if}{/each}{:else}{#each linkedText(turn) as part}{#if part.id}<button class="citation" onclick={() => selectNode(part.id!)}>{part.text}</button>{:else}{part.text}{/if}{/each}{/if}</p>{/each}
        </div>
      {/if}
      {#if experiment}
        {#key active.id}
          <PilotMentionComposer bind:this={mentionComposer} currentId={active.id}
            recents={[{ id: active.id, title: active.title, tag: "PILOT", date: "Sep 15 10:30" }, ...MENTION_RECENTS]}
            initial={active.mentionParts ?? []}
            onchange={parts => { if (active) { active.mentionParts = parts; active.draft = mentionText(parts); } }} onsend={send} />
        {/key}
      {:else}
      <textarea bind:this={composer} bind:value={active.draft} aria-label="Message Pilot" rows="1"
        class:waiting={active.phase === "working"}
        placeholder={active.phase === "working" ? "Pilot is working…" : active.turns.length ? "Continue the conversation…" : attached.length ? `ask about ${title(attached[0])}` : "ask anything…"}
        onkeydown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }}></textarea>
      {/if}
    </section>
  {:else}
    <div class="graph-hint">Click to select · Shift-click to add · {#if active}<button onclick={() => selectNode(active!.id)}>Return to session</button>{:else}<button onclick={() => start()}>⇧↵ Start a session</button>{/if}</div>
  {/if}
</section>

<style>
  .pilot-workbench { --pilot: var(--activity); position: relative; height: 100%; min-height: 540px; overflow: hidden; background: var(--bg); color: var(--text-strong); font-family: var(--font-app); }
  button { font: inherit; color: inherit; cursor: pointer; background: transparent; border: 0; }
  button:focus-visible, .node:focus-visible, .session-node:focus-visible { outline: 2px solid var(--pilot); outline-offset: 4px; }
  .search-row { position: absolute; top: 28px; left: 28px; right: 28px; display: flex; gap: 14px; z-index: 2; }
  .search { display: flex; align-items: center; gap: 15px; background: var(--well); border-radius: 18px; padding: 18px 22px; flex: 1; min-width: 0; color: var(--text-muted); }
  .search svg { stroke: currentColor; stroke-width: 1.5; flex: none; }
  .search input { background: transparent; border: 0; outline: none; color: var(--text); font: 20px var(--font-app); width: 100%; min-width: 0; }
  .search input::placeholder { color: var(--text-muted); }
  kbd { font: 11px var(--font-mono); }
  .settings { width: 62px; border-radius: 50%; background: var(--well); color: var(--text-muted); font: 13px var(--font-mono); }
  .view-bar { position: absolute; top: 112px; left: 30px; right: 30px; z-index: 2; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font: 11px var(--font-mono); text-transform: uppercase; letter-spacing: 1.4px; color: var(--text-muted); }
  strong { color: var(--pilot); font-weight: 650; }
  .view-bar button { color: var(--text-faint); text-transform: uppercase; letter-spacing: inherit; padding: 0; }
  .view-bar button:hover { color: var(--pilot); }
  .view-bar .new-session { margin-left: auto; color: var(--text-muted); }
  .graph { width: 100%; height: 100%; display: block; }
  .camera { transition: transform 650ms cubic-bezier(.2,.75,.2,1); }
  .background { opacity: .5; transition: opacity .4s; }
  .background.dimmed { opacity: .25; }
  .background path { stroke: var(--text-faint); stroke-width: .65; opacity: .23; }
  .background circle { fill: var(--text-muted); opacity: .38; }
  .relation { stroke: var(--text-muted); stroke-width: 1; opacity: .18; transition: opacity .5s, stroke-width .5s; }
  .relation.lit { stroke: var(--text-strong); opacity: .6; stroke-width: 1.45; }
  .session-edge { stroke: var(--pilot); fill: none; stroke-width: 1.1; stroke-dasharray: 7 7; opacity: .75; }
  .flow { animation: flow 850ms linear infinite; }
  @keyframes flow { to { stroke-dashoffset: -28; } }
  .inactive { opacity: .3; }
  .node, .session-node { cursor: pointer; outline: none; }
  .node { transition: opacity .4s; }
  .node.muted { opacity: .25; }
  .node:hover { opacity: 1; }
  .hit { fill: transparent; stroke: none; }
  .node-core { fill: var(--text-strong); stroke: var(--text-strong); stroke-width: 1.5; }
  .node-core.hollow, .node-selector { fill: var(--bg); }
  .node-selector { stroke: var(--text-strong); stroke-width: 1; opacity: .65; }
  text { text-anchor: middle; fill: var(--text-strong); font: 12px var(--font-app); paint-order: stroke; stroke: var(--bg); stroke-width: 4px; stroke-linejoin: round; }
  .session-title { fill: var(--pilot); }
  .draft-mirror { fill: var(--text-muted); font-size: 11px; }
  .composer-panel { position: absolute; bottom: 28px; left: 28px; right: 28px; z-index: 3; border: 1px solid var(--rule); border-radius: 16px; background: var(--bg); box-shadow: 0 8px 24px color-mix(in srgb, var(--fg) 3%, transparent); overflow: hidden; }
  .composer-panel.experiment { overflow: visible; display: flex; flex-direction: column; box-sizing: border-box; }
  .composer-panel.experiment { background: color-mix(in srgb, var(--bg) 65%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
  .composer-panel.expanded { height: calc(100% - 178px); }
  .experiment header, .experiment .context-items { flex: none; }
  .experiment .transcript { flex: 1; min-height: 0; }
  .expanded .transcript { flex: 1; min-height: 0; max-height: none; }
  .experiment :global(.mention-composer) { flex: 0 0 auto; margin-top: auto; }
  .experiment .transcript p:last-child { border-bottom: 0; }
  .sent-mention { color: var(--text-strong); background: var(--well); border: 1px solid var(--rule); border-radius: 5px; padding: 2px 6px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
  .sent-mention > span { font-size: .75em; }
  header { display: flex; align-items: center; gap: 14px; min-height: 48px; padding: 9px 20px; border-bottom: 1px solid var(--rule); font: 10px var(--font-mono); letter-spacing: 1.3px; text-transform: uppercase; }
  header strong { white-space: nowrap; max-width: 25%; overflow: hidden; text-overflow: ellipsis; }
  .header-indicator { width: 28px; height: 28px; display: inline-flex; flex: none; }
  .header-indicator :global(svg) { width: 28px; height: 28px; }
  .status { color: var(--text-muted); white-space: nowrap; }
  .context { padding: 0; text-align: left; text-transform: uppercase; letter-spacing: inherit; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commands { display: flex; align-items: center; gap: 12px; margin-left: auto; flex: none; color: var(--text-muted); }
  .commands button { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; padding: 0 4px; border-radius: 4px;
    font: 10px/1 var(--font-mono); text-transform: uppercase; letter-spacing: 1px; white-space: nowrap; color: inherit; }
  .commands button:not(:disabled):hover { background: var(--well); }
  .resize-controls { display: flex; align-items: center; gap: 2px; }
  .commands .icon-command { width: 28px; height: 28px; padding: 0; flex: none; }
  .icon-command svg { display: block; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
  .session-edge.dormant { stroke: var(--text-muted); stroke-dasharray: none; }
  .session-node.dormant .session-title { fill: var(--text-strong); }
  .commands button:disabled { opacity: .4; cursor: default; }
  textarea { display: block; width: 100%; box-sizing: border-box; border: 0; outline: none; resize: none; padding: 12px 20px; background: transparent; color: var(--text-strong); font: var(--fw-regular) var(--fs-chip)/1.5 var(--font-app); caret-color: var(--pilot); field-sizing: content; max-height: 130px; }
  textarea::placeholder { color: var(--text-faint); }
  textarea.waiting { color: var(--text-muted); }
  .transcript { padding: 12px 20px 0; max-height: min(230px, 25vh); overflow-y: auto; font: var(--fw-regular) var(--fs-chip)/1.5 var(--font-app); color: var(--text); }
  .transcript p { max-width: 920px; margin: 0 0 12px; white-space: pre-wrap; }
  .transcript p:last-child { padding-bottom: 12px; margin-bottom: 0; border-bottom: 1px solid var(--rule); }
  .transcript .user { color: var(--text-muted); }
  .citation { color: var(--pilot); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--pilot) 45%, transparent); text-underline-offset: 3px; padding: 0; }
  .graph-hint { position: absolute; bottom: 30px; left: 30px; right: 30px; text-align: center; font: 12px var(--font-mono); color: var(--text-faint); }
  .graph-hint button { color: var(--text-muted); }
  .context-items { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px 23px 0; font-size: 12px; }
  .context-items span { background: var(--well); border-radius: 5px; padding: 5px 9px; }
  .context-items button { margin-left: 8px; }
  .tuning, .search-results { position: absolute; z-index: 5; padding: 18px; background: var(--surface); box-shadow: 0 8px 30px #0001; border: 1px solid var(--rule); border-radius: 12px; font: 12px var(--font-mono); }
  .tuning { top: 103px; right: 28px; width: 240px; }
  .tuning label { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; }
  .tuning input { width: 100%; accent-color: var(--pilot); }
  .tuning button { margin-top: 12px; }
  .search-results { top: 96px; left: 30px; display: grid; min-width: 250px; gap: 12px; }
  @media (max-width: 850px) { .composer-panel.expanded { height: calc(100% - 166px); } header { flex-wrap: wrap; gap: 8px; padding: 10px 14px; } header strong { max-width: 65%; } .context { flex: 1; } .commands { width: 100%; justify-content: flex-end; gap: 12px; } .composer-panel { left: 16px; right: 16px; bottom: 16px; } .search-row { left: 16px; right: 16px; top: 16px; } .view-bar { left: 20px; right: 20px; top: 100px; font-size: 9px; gap: 8px; } }
  @media (prefers-reduced-motion: reduce) { .camera, .node, .relation, .background { transition: none; } .flow { animation: none; } .composer-panel.experiment { transition: none; } }
</style>
