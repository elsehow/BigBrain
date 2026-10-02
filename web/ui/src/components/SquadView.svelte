<script lang="ts">
  // #/squad — the vault as a field, the agents writing it placed over what
  // they're writing, and the record read as it lands. The canvas is
  // lib/squad/scene.ts (three.js, loaded on demand); everything with words
  // is here. Keys: 1–9 an agent, / search by name, Esc back out.
  import { getContext, onMount, tick } from "svelte";
  import { SIDEBAR_LAYOUT, type SidebarLayout } from "../lib/sidebarLayout";
  import { api } from "../lib/api";
  import type { GraphData } from "../lib/types";
  import { buildField, neighbours, searchNames, twinsOf, type Field, type SquadData, type SquadFeedRow } from "../lib/squad/model";
  import type { SquadScene } from "../lib/squad/scene";
  import { plainText as plain } from "../../../../lib/squadGraph";

  /** The workbench hands in fabricated data; the app fetches the vault's. */
  let { data = null }: { data?: { graph: GraphData; squad: SquadData } | null } = $props();

  let host: HTMLDivElement;
  let hudEl: HTMLElement | undefined = $state();
  let feedEl: HTMLElement | undefined = $state();
  let searchEl: HTMLElement | undefined = $state();
  let qEl: HTMLInputElement | undefined = $state();
  let field: Field | null = $state(null);
  let squad: SquadData | null = $state(null);
  let error = $state("");
  let scene: SquadScene | null = null;
  let twins = new Map<number, number[]>();

  let sel: number | null = $state(null);
  let ent: number | null = $state(null);
  let entRows: SquadFeedRow[] | null = $state(null);
  let searching = $state(false);
  let query = $state("");
  let matches: number[] = $state([]);
  let active = $state(0);

  const agentIndex = (id: string | null) => (id == null ? -1 : squad?.agents.findIndex((a) => a.id === id) ?? -1);
  const agentName = (id: string | null) => (id ? squad?.agents.find((a) => a.id === id)?.name ?? id : "Import");
  const when = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "2-digit" }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };
  const ago = (iso: string) => {
    const h = (Date.now() - Date.parse(iso)) / 36e5;
    return h < 1 ? "just now" : h < 24 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`;
  };
  /** The agents whose recent feed rows mention an entity. */
  const writersOf = (id: string) => [...new Set(squad!.feed.filter((r) => r.entities.includes(id) && r.agent).map((r) => agentName(r.agent)))];

  // the feed: an opened entity's own record, else the selected agent's, else everyone's
  let rows = $derived.by(() => {
    if (!squad) return [];
    if (ent != null && entRows) return entRows.slice(-6);
    const a = sel != null ? squad.agents[sel]?.id : null;
    return (a ? squad.feed.filter((r) => r.agent === a) : squad.feed).slice(-6);
  });
  let hud = $derived.by(() => {
    if (!field || !squad || searching) return null;
    if (ent != null) {
      const n = field.nodes[ent]!;
      const tw = (twins.get(ent) ?? []).map((j) => field!.nodes[j]!.label);
      const who = writersOf(n.id);
      return {
        eyebrow: n.memory ? "Memory" : `${n.degree} ${n.degree === 1 ? "tie" : "ties"}`, name: n.label,
        status: (who.length ? `Lately written about by ${who.join(", ")}.` : "") + (tw.length ? ` Also in your vault as “${tw.join("”, “")}”.` : ""),
        hot: false,
      };
    }
    if (sel != null) {
      const a = field.agents[sel]!;
      return { eyebrow: `${a.key} · ${a.working ? "working" : "idle"} · ${a.name}`, name: a.task?.label ?? a.name,
        status: `${a.count.toLocaleString()} assertions written. The last one ${ago(a.lastAt)}.`, hot: a.working };
    }
    return null;
  });

  async function load(): Promise<void> {
    try {
      const [graph, sq] = data ? [data.graph, data.squad] : await Promise.all([api.graph(), api.squad()]);
      squad = sq;
      field = buildField(graph, sq);
      twins = twinsOf(field);
      const { createSquadScene } = await import("../lib/squad/scene");
      const f = field;
      const sets = f.agents.map((a) => new Set([...a.touchIdx, ...sq.feed.filter((r) => r.agent === a.id).flatMap((r) => r.entities.map((id) => f.byId.get(id)).filter((x): x is number => x != null))]));
      scene = createSquadScene(host, f, sets, {
        blockers: () => [hudEl, feedEl, searching ? searchEl : undefined].filter((e): e is HTMLElement => !!e).map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0),
        onPickAgent: (i) => selectAgent(sel === i ? null : i),
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  // the shell owns the keyboard (AppShell's capture listener); a ground view
  // answers first through its hook, and outside the shell (the workbench) the
  // window listener below does the same job
  const shell = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);
  onMount(() => {
    void load();
    if (shell) shell.viewKey = onKey;
    return () => { if (shell?.viewKey === onKey) shell.viewKey = undefined; scene?.dispose(); };
  });

  const shiftFor = () => (searching ? Math.min(300, innerWidth * 0.2) : sel != null || ent != null ? Math.min(190, innerWidth * 0.13) : 0);
  function selectAgent(i: number | null): void {
    ent = null; entRows = null; sel = i;
    scene?.openEntity(null);
    scene?.selectAgent(i);
    scene?.shift(shiftFor());
  }

  /** An entity's latest word: the feed's if it's there, else its own record. */
  async function latestWord(i: number): Promise<string | undefined> {
    const n = field!.nodes[i]!;
    const inFeed = [...squad!.feed].reverse().find((r) => r.entities.includes(n.id));
    if (inFeed) return inFeed.text;
    if (data || !n.path) return undefined;
    try { return plain((await api.note(n.path, 1)).projectedEntity?.assertions.at(-1)?.text ?? "") || undefined; } catch { return undefined; }
  }
  async function openEntity(i: number): Promise<void> {
    if (!field || !squad) return;
    sel = null; ent = i; entRows = null;
    scene?.selectAgent(null);
    scene?.openEntity(i, neighbours(field, i));
    scene?.shift(shiftFor());
    const n = field.nodes[i]!;
    const word = await latestWord(i);
    if (ent === i) scene?.openEntity(i, neighbours(field, i), word);
    if (data || !n.path) { entRows = squad.feed.filter((r) => r.entities.includes(n.id)); return; }
    try {
      const view = (await api.note(n.path, 6)).projectedEntity;
      if (ent !== i || !view) return;
      entRows = view.assertions.map((a) => ({ id: a.id, at: a.created_at, agent: squad!.agents.some((g) => g.id === a.author.id) ? a.author.id : null, text: plain(a.text), entities: [n.id] }));
    } catch { entRows = squad.feed.filter((r) => r.entities.includes(n.id)); }
  }

  // ── search by name ─────────────────────────────────────────────────────
  function openSearch(): void {
    searching = true; query = ""; matches = []; active = 0;
    scene?.search({ matches: [], active: null, move: "frame" });
    scene?.shift(shiftFor());
    void tick().then(() => qEl?.focus());
  }
  function closeSearch(): void {
    searching = false;
    scene?.search(null);
    scene?.shift(shiftFor());
    if (ent != null) void openEntity(ent); else scene?.selectAgent(sel);
  }
  async function runQuery(): Promise<void> {
    if (!field) return;
    matches = searchNames(field, query);
    active = 0;
    scene?.search({ matches, active: matches[0] ?? null, move: "frame" });
    await sayActive();
  }
  async function setActive(k: number): Promise<void> {
    if (!matches.length) return;
    active = (k + Math.min(matches.length, 9)) % Math.min(matches.length, 9);
    scene?.search({ matches, active: matches[active]!, move: "glide" });
    await sayActive();
  }
  /** The active match's latest word, once it arrives; the camera holds still. */
  async function sayActive(): Promise<void> {
    const i = matches[active];
    if (i == null) return;
    const text = await latestWord(i);
    if (searching && matches[active] === i) scene?.search({ matches, active: i, text, move: "none" });
  }
  function commit(k = active): void {
    const i = matches[k];
    if (i == null) return;
    searching = false;
    scene?.search(null);
    void openEntity(i);
  }
  const metaOf = (i: number) => {
    const n = field!.nodes[i]!;
    const who = writersOf(n.id).slice(0, 2);
    const tw = (twins.get(i) ?? []).map((j) => field!.nodes[j]!.label);
    return [`${n.degree} ${n.degree === 1 ? "tie" : "ties"}`, ...(who.length ? [who.join(", ")] : []), ...(tw.length ? [`also “${tw.join("”, “")}”`] : [])].join(" · ");
  };
  const marked = (label: string) => {
    const i = label.toLowerCase().indexOf(query.trim().toLowerCase());
    return i < 0 || !query.trim() ? [label, "", ""] : [label.slice(0, i), label.slice(i, i + query.trim().length), label.slice(i + query.trim().length)];
  };

  /** True when this view took the key (so the shell's shortcuts don't also fire). */
  function onKey(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey || !field) return false;
    if (searching && e.target === qEl) {
      // typing in the search box is ours entirely; the characters still land
      if (e.key === "ArrowDown") { take(e); void setActive(active + 1); }
      else if (e.key === "ArrowUp") { take(e); void setActive(active - 1); }
      else if (e.key === "Enter") { take(e); commit(); }
      else if (e.key === "Escape") { take(e); closeSearch(); }
      return true;
    }
    const t = e.target as HTMLElement | null;
    if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return false;
    if (e.key === "/") { take(e); openSearch(); return true; }
    if (e.key === "Escape" && (sel != null || ent != null)) { take(e); selectAgent(null); return true; }
    const k = Number(e.key);
    if (k >= 1 && k <= field.agents.length) { take(e); selectAgent(sel === k - 1 ? null : k - 1); return true; }
    return false;
  }
  function take(e: KeyboardEvent): void { e.preventDefault(); e.stopPropagation(); }
</script>

<svelte:head>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" />
</svelte:head>
<svelte:window onkeydowncapture={(e) => { if (!shell) onKey(e); }} />

<div class="squad">
  <div class="stage" bind:this={host}></div>

  {#if field}
    <nav class="strip" aria-label="Agents">
      {#each field.agents as a (a.id)}
        <button type="button" class="tok" class:on={sel === a.i} class:working={a.working} aria-pressed={sel === a.i} onclick={() => selectAgent(sel === a.i ? null : a.i)}>
          <svg width="12" height="12" viewBox="-12 -12 24 24" aria-hidden="true"><path d="M 0 9 L 7.794 -4.5 L -7.794 -4.5 Z" /></svg>
          <span class="k">{a.key}</span>{a.task?.label ?? a.name}<span class="by">{a.name}</span>
        </button>
      {/each}
      <button type="button" class="find" onclick={openSearch}>Search <span class="k">/</span></button>
    </nav>
  {/if}

  {#if hud}
    <header class="hud" bind:this={hudEl}>
      <span class="eyebrow" class:hot={hud.hot}>{hud.eyebrow}</span>
      <h1>{hud.name}</h1>
      {#if hud.status}<p>{hud.status}</p>{/if}
    </header>
  {/if}

  {#if searching && field}
    <div class="search" bind:this={searchEl} role="dialog" aria-label="Search by name">
      <div class="field">
        <input bind:this={qEl} bind:value={query} oninput={() => void runQuery()} placeholder="Find anything by name…" aria-label="Find by name" autocomplete="off" spellcheck="false" />
        <span class="k">Esc</span>
      </div>
      {#if query.trim()}
        <p class="count">{matches.length ? `${matches.length} ${matches.length === 1 ? "thing" : "things"} in your vault` : `Nothing in your vault is called “${query.trim()}”.`}</p>
        <ul role="listbox" aria-label="Matches">
          {#each matches.slice(0, 9) as i, k (i)}
            {@const parts = marked(field.nodes[i]!.label)}
            <li role="option" aria-selected={k === active} onmouseenter={() => void setActive(k)} onclick={() => commit(k)} onkeydown={() => {}}>
              <span class="dot" style:--r={`${2.2 + Math.min(3.6, Math.log1p(field.nodes[i]!.degree) * 0.62)}px`}></span>
              <span class="ttl">{parts[0]}<mark>{parts[1]}</mark>{parts[2]}</span>
              <span class="meta">{metaOf(i)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if rows.length}
    <div class="feed" bind:this={feedEl} aria-label="Latest assertions">
      {#each rows as r (r.id)}
        <div class="row" role="presentation"
          onmouseenter={() => scene?.hover(r.entities.map((id) => field!.byId.get(id)).filter((x): x is number => x != null), agentIndex(r.agent) >= 0 ? agentIndex(r.agent) : null)}
          onmouseleave={() => scene?.hover(null, null)}>
          <span class="w">{when(r.at)}</span><span class="a">{agentName(r.agent)}</span><span class="x">{r.text}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if error}<p class="error">The squad view couldn’t load: {error}</p>{/if}
</div>

<style>
  .squad {
    --font-app: "IBM Plex Sans", system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, monospace;
    --sq-muted: color-mix(in srgb, var(--fg) 65%, var(--bg));
    --sq-faint: color-mix(in srgb, var(--fg) 45%, var(--bg));
    position: fixed; inset: 0; z-index: 0; background: var(--bg);
    font-family: var(--font-app); color: var(--fg); overflow: hidden;
  }
  .stage { position: absolute; inset: 0; }
  .stage :global(.sq-canvas) { display: block; width: 100%; height: 100%; touch-action: none; }
  .stage :global(.sq-labels) { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .stage :global(.sq-lab) { position: absolute; left: 0; top: 0; white-space: nowrap; will-change: transform, opacity;
    text-shadow: 0 0 3px var(--bg), 0 0 8px var(--bg), 0 0 16px var(--bg); }
  .stage :global(.sq-node .t) { font: 400 11px/1.2 var(--font-mono); letter-spacing: -0.01em; color: var(--sq-muted); }
  .stage :global(.sq-node.memory .t) { font: 500 12px/1.2 var(--font-app); color: var(--fg); }
  .stage :global(.sq-node .q) { display: none; }
  .stage :global(.sq-node.full .t) { display: none; }
  .stage :global(.sq-node.full .q) { display: block; white-space: normal; width: max-content; max-width: 32ch;
    font: 400 13px/1.45 var(--font-app); color: color-mix(in srgb, var(--fg) 82%, var(--bg)); }
  .stage :global(.sq-node .q b) { font-weight: 600; color: var(--fg); }
  .stage :global(.sq-agent) { display: flex; gap: 6px; align-items: baseline; font: 500 11px/1 var(--font-mono); color: var(--sq-muted); }
  .stage :global(.sq-agent .k) { font-size: 9.5px; }
  .stage :global(.sq-agent.working) { color: color-mix(in srgb, var(--activity) 80%, var(--fg)); }

  .strip { position: absolute; top: calc(var(--topbar-h, 92px) - 6px); left: var(--app-gutter, 34px); right: var(--app-gutter, 34px); display: flex; flex-wrap: wrap; gap: 4px; }
  .tok, .find { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 11px; border: 0; border-radius: 999px;
    background: color-mix(in srgb, var(--bg) 70%, transparent); color: var(--fg); font: 500 13px/1 var(--font-app); cursor: pointer; }
  .tok svg { fill: currentColor; }
  .tok.working svg { fill: none; stroke: var(--activity); stroke-width: 2.4; }
  .tok:hover, .find:hover { background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  .tok.on { background: var(--fg); color: var(--bg); }
  .tok .by { font: 400 11px/1 var(--font-mono); color: var(--sq-faint); }
  .tok.on .by { color: color-mix(in srgb, var(--bg) 65%, var(--fg)); }
  .k { font: 500 10px/1 var(--font-mono); color: var(--sq-faint); }
  .tok.on .k { color: color-mix(in srgb, var(--bg) 65%, var(--fg)); }
  .find { margin-left: auto; color: var(--sq-muted); }

  .hud { position: absolute; top: calc(var(--topbar-h, 92px) + 48px); left: var(--app-gutter, 34px); width: min(460px, calc(100% - 32px)); display: flex; flex-direction: column; gap: 9px;
    pointer-events: none; text-shadow: 0 0 8px var(--bg), 0 0 18px var(--bg); }
  .eyebrow { font: 600 10px/1 var(--font-app); letter-spacing: 0.24em; text-transform: uppercase; color: var(--sq-muted); }
  .eyebrow.hot { color: color-mix(in srgb, var(--activity) 80%, var(--fg)); }
  h1 { margin: 0; font: 500 clamp(28px, 2.5vw, 36px)/1.05 var(--font-app); letter-spacing: -0.03em; }
  .hud p { margin: 0; max-width: 44ch; font: 400 14.5px/1.5 var(--font-app); color: color-mix(in srgb, var(--fg) 80%, var(--bg)); }

  .search { position: absolute; top: calc(var(--topbar-h, 92px) + 38px); left: calc(var(--app-gutter, 34px) - 8px); width: min(480px, calc(100% - 32px)); z-index: 2;
    border-radius: 11px; background: var(--bg); box-shadow: 0 0 0 1px var(--rule), 0 28px 70px -28px color-mix(in srgb, var(--fg) 45%, transparent); overflow: hidden; }
  .field { display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 18px; }
  .field input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--fg); font: 400 19px/1 var(--font-app); }
  .count { margin: 0; padding: 12px 22px 6px; border-top: 1px solid var(--rule); font: 600 10px/1 var(--font-app); letter-spacing: 0.24em; text-transform: uppercase; color: var(--sq-muted); }
  ul { list-style: none; margin: 0; padding: 4px 6px 8px; max-height: min(62vh, 560px); overflow-y: auto; }
  li { display: grid; grid-template-columns: 22px minmax(0, 1fr); grid-template-rows: auto auto; column-gap: 10px; padding: 9px 12px; border-radius: 8px; cursor: pointer; }
  li[aria-selected="true"] { background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  .dot { grid-row: span 2; align-self: center; justify-self: center; width: calc(var(--r) * 2); height: calc(var(--r) * 2); border-radius: 50%; background: var(--fg); }
  .ttl { font: 500 15px/1.3 var(--font-app); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  mark { background: none; color: color-mix(in srgb, var(--activity) 80%, var(--fg)); font-weight: 600; }
  .meta { font: 400 12.5px/1.35 var(--font-app); color: var(--sq-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .feed { position: absolute; left: var(--app-gutter, 34px); bottom: 26px; width: min(880px, calc(100% - 68px)); display: flex; flex-direction: column; gap: 1px;
    font: 400 12.5px/1.35 var(--font-app); text-shadow: 0 0 6px var(--bg), 0 0 14px var(--bg); }
  .row { display: grid; grid-template-columns: 92px 120px minmax(0, 1fr); gap: 12px; align-items: baseline; padding: 2px 0; white-space: nowrap; cursor: default; transition: opacity .12s ease; }
  .row .w { font: 500 9.5px/1 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--sq-faint); font-variant-numeric: tabular-nums; }
  .row .a { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .row .x { overflow: hidden; text-overflow: ellipsis; color: color-mix(in srgb, var(--fg) 82%, var(--bg)); }
  .row:nth-last-child(2) { opacity: .7; } .row:nth-last-child(3) { opacity: .5; } .row:nth-last-child(4) { opacity: .36; }
  .row:nth-last-child(5) { opacity: .25; } .row:nth-last-child(6) { opacity: .16; }
  .feed:hover .row { opacity: .45; } .feed .row:hover { opacity: 1; } .row:hover .x { color: var(--fg); }
  .error { position: absolute; top: calc(var(--topbar-h, 92px) + 40px); left: var(--app-gutter, 34px); font: 400 13px/1.5 var(--font-app); color: var(--sq-muted); }
  @media (max-width: 700px) {
    .row { grid-template-columns: 72px minmax(0, 1fr); } .row .w { display: none; }
    .tok .by { display: none; }
  }
</style>
