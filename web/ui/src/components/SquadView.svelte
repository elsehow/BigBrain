<script lang="ts">
  // /squad (its own page, squad.html) — the vault as a field, and the record
  // read as it lands, each assertion with its author. The canvas is
  // lib/squad/scene.ts (three.js, loaded on demand); everything with words
  // is here. Keys: / search by name, j/k step through the memory topics,
  // Shift+Enter starts a pilot on what's in hand (and opens it in the app),
  // Esc back out.
  import { onMount, tick } from "svelte";
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

  let ent: number | null = $state(null);
  let entRows: SquadFeedRow[] | null = $state(null);
  let searching = $state(false);
  let query = $state("");
  let matches: number[] = $state([]);
  let active = $state(0);
  let notice = $state("");

  const authorName = (id: string | null) => (id ? squad?.authors.find((a) => a.id === id)?.name ?? id : "You");
  const when = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "2-digit" }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };
  /** Who wrote the recent feed rows that mention an entity. */
  const writersOf = (id: string) => [...new Set(squad!.feed.filter((r) => r.entities.includes(id) && r.author).map((r) => authorName(r.author)))];

  // the feed: an opened entity's own record, else the vault's latest
  let rows = $derived.by(() => (!squad ? [] : ent != null && entRows ? entRows.slice(-6) : squad.feed.slice(-6)));
  let hud = $derived.by(() => {
    if (!field || !squad || searching) return null;
    if (ent != null) {
      const n = field.nodes[ent]!;
      const tw = (twins.get(ent) ?? []).map((j) => field!.nodes[j]!.label);
      const who = writersOf(n.id);
      return {
        eyebrow: n.memory ? "Memory" : `${n.degree} ${n.degree === 1 ? "tie" : "ties"}`, name: n.label,
        status: (who.length ? `Lately written about by ${who.join(", ")}.` : "") + (tw.length ? ` Also in your vault as “${tw.join("”, “")}”.` : ""),
      };
    }
    return null;
  });

  async function load(): Promise<void> {
    try {
      const [graph, sq] = data ? [data.graph, data.squad] : await Promise.all([api.graph(), api.squad()]);
      squad = sq;
      field = buildField(graph);
      twins = twinsOf(field);
      const { createSquadScene } = await import("../lib/squad/scene");
      scene = createSquadScene(host, field, {
        blockers: () => [hudEl, feedEl, searching ? searchEl : undefined].filter((e): e is HTMLElement => !!e).map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0),
        onPick,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  onMount(() => {
    void load();
    return () => scene?.dispose();
  });

  /** A click in the field: open what's under it; empty space backs out. */
  function onPick(i: number | null): void {
    if (i == null) { if (ent != null && !searching) overview(); return; }
    if (searching) { searching = false; scene?.search(null); }
    if (i !== ent) void openEntity(i);
  }
  const shiftFor = () => (searching ? Math.min(300, innerWidth * 0.2) : ent != null ? Math.min(190, innerWidth * 0.13) : 0);
  function overview(): void {
    ent = null; entRows = null;
    scene?.overview();
    scene?.shift(shiftFor());
  }

  /** The memory topics, left to right across the field: j/k's order. */
  let memories: number[] = $derived.by(() => {
    const f: Field | null = field;
    return f ? f.nodes.filter((n) => n.memory).sort((a, b) => a.p[0] - b.p[0]).map((n) => n.i) : [];
  });
  function stepMemory(dir: 1 | -1): void {
    if (!memories.length) return;
    const at = ent == null ? -1 : memories.indexOf(ent);
    const next = at < 0 ? (dir > 0 ? 0 : memories.length - 1) : (at + dir + memories.length) % memories.length;
    void openEntity(memories[next]!);
  }
  /** A memory topic's own first paragraph: citations dropped, links read as labels. */
  async function memorySummary(path: string): Promise<string | undefined> {
    try {
      const body = (await api.note(path)).content.replace(/^---[\s\S]*?\n---\n/, "");
      const para = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#"));
      if (!para) return undefined;
      const text = plain(para.replace(/\s*\[\[ast_[^\]]*\]\]/g, "")).replace(/[*_`]/g, "");
      return text.length <= 240 ? text : text.slice(0, 239).replace(/\s+\S*$/, "") + "…";
    } catch { return undefined; }
  }

  /** What Shift+Enter starts a pilot on: the active search result, else the opened thing. */
  const inHand = () => (searching ? matches[active] ?? null : ent);
  /** A pilot seeded with that note, as the app's own lists start one; then open it there. */
  async function startPilot(): Promise<void> {
    const i = inHand();
    const path = i == null ? null : field?.nodes[i]?.path;
    if (!path) { flash("Open something first — Shift+Enter starts a pilot on it."); return; }
    const id = `pilot-${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      const r = await fetch("/api/pilot/chat/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, context: [path] }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `The engine said ${r.status}.`);
      location.href = `./#/session/${id}`;
    } catch (e) {
      flash(`Couldn’t start a pilot: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function flash(text: string): void { notice = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice = ""; }, 4200); }

  type Said = { text: string; caption: string } | undefined;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  /** An entity's own latest assertions, dated by when each claim was first recorded. */
  async function entityRows(i: number): Promise<SquadFeedRow[]> {
    const n = field!.nodes[i]!;
    if (data) return squad!.feed.filter((r) => r.entities.includes(n.id));
    try { return (await api.squadEntity(n.id)).rows; } catch { return squad!.feed.filter((r) => r.entities.includes(n.id)); }
  }
  /** An entity's latest assertion. */
  async function latestWord(i: number): Promise<Said> {
    const last = (await entityRows(i)).at(-1);
    return last ? { text: last.text, caption: `Latest assertion · ${day(last.at)}` } : undefined;
  }
  /** Quick's briefing on a note — the summary the app shows when you select it.
   * Cached by the engine per note and evidence; a fresh one streams as it's written. */
  async function briefing(path: string, onText: (text: string) => void): Promise<boolean> {
    try {
      const r = await fetch("/api/note/briefing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, stream: true }) });
      if (!r.ok || !r.body) return false;
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "", done = false;
      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        buf += dec.decode(chunk.value ?? new Uint8Array(), { stream: !done });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as { type: string; text?: string; briefing?: { summary: string }; error?: string };
          if (ev.type === "preview" && ev.text) onText(plain(ev.text));
          else if (ev.type === "complete" && ev.briefing) { onText(plain(ev.briefing.summary)); return true; }
          else if (ev.type === "error") return false;
        }
      }
      return false;
    } catch { return false; }
  }
  async function openEntity(i: number): Promise<void> {
    if (!field || !squad) return;
    ent = i; entRows = null;
    scene?.openEntity(i, neighbours(field, i));
    scene?.shift(shiftFor());
    const n = field.nodes[i]!;
    const ties = neighbours(field, i);
    // beside it, at once: the memory's own opening lines, or the latest assertion;
    // then Quick's summary as it arrives, if the engine will give one
    const first: Said = n.memory
      ? (data || !n.path ? undefined : await memorySummary(n.path).then((t) => (t ? { text: t, caption: "From the memory note" } : undefined)))
      : await latestWord(i);
    if (ent !== i) return;
    scene?.openEntity(i, ties, first?.text, first?.caption);
    if (!data && n.path) void briefing(n.path, (text) => { if (ent === i) scene?.openEntity(i, ties, text, "Summary · Quick"); });
    if (n.memory) {
      // a memory topic is a note, not an entity: its feed is about what it cites
      const cites = new Set(neighbours(field, i, 24).map((j) => field!.nodes[j]!.id));
      entRows = squad.feed.filter((r) => r.entities.some((id) => cites.has(id)));
      return;
    }
    const own = await entityRows(i);
    if (ent === i) entRows = own;
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
    if (ent != null) void openEntity(ent); else scene?.overview();
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
    const said = await latestWord(i);
    if (searching && matches[active] === i) scene?.search({ matches, active: i, text: said?.text, caption: said?.caption, move: "none" });
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

  /** True when this view took the key. */
  function onKey(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey || !field) return false;
    if (searching && e.target === qEl) {
      // typing in the search box is ours entirely; the characters still land
      if (e.key === "ArrowDown") { take(e); void setActive(active + 1); }
      else if (e.key === "ArrowUp") { take(e); void setActive(active - 1); }
      else if (e.key === "Enter" && e.shiftKey) { take(e); void startPilot(); }
      else if (e.key === "Enter") { take(e); commit(); }
      else if (e.key === "Escape") { take(e); closeSearch(); }
      return true;
    }
    const t = e.target as HTMLElement | null;
    if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return false;
    if (e.key === "/") { take(e); openSearch(); return true; }
    if (e.key === "Escape" && ent != null) { take(e); overview(); return true; }
    if (e.key === "j" || e.key === "k") { take(e); stepMemory(e.key === "j" ? 1 : -1); return true; }
    if (e.key === "Enter" && e.shiftKey) { take(e); void startPilot(); return true; }
    return false;
  }
  function take(e: KeyboardEvent): void { e.preventDefault(); e.stopPropagation(); }
</script>

<svelte:head>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" />
</svelte:head>
<svelte:window onkeydown={onKey} />

<div class="squad">
  <div class="stage" bind:this={host}></div>

  {#if field}
    <nav class="strip" aria-label="Squad">
      <button type="button" class="find" onclick={openSearch}>Search <span class="k">/</span></button>
      <a class="app" href="./">BigBrain</a>
    </nav>
  {/if}

  {#if hud}
    <header class="hud" bind:this={hudEl}>
      <span class="eyebrow">{hud.eyebrow}</span>
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
          onmouseenter={() => scene?.hover(r.entities.map((id) => field!.byId.get(id)).filter((x): x is number => x != null))}
          onmouseleave={() => scene?.hover(null)}>
          <span class="w" title={r.writtenAt ? `First recorded ${when(r.at)}; this version written ${when(r.writtenAt)}` : undefined}>{when(r.at)}</span>
          <span class="a" class:client={!r.model} title={r.model ? `Written by ${r.by}` : r.author ? `Written through ${authorName(r.author)}; the model it ran isn’t recorded` : "Written by you"}>{r.by}</span>
          <span class="x">{r.text}</span>
        </div>
      {/each}
    </div>
  {/if}

  <p class="hints" aria-hidden="true"><span>/ Search</span><span>j k Memories</span><span>⇧↵ Pilot</span>{#if ent != null}<span>Esc Back</span>{/if}</p>
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if error}<p class="error">The squad view couldn’t load: {error}</p>{/if}
</div>

<style>
  .squad {
    --font-app: "IBM Plex Sans", system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, monospace;
    --sq-muted: color-mix(in srgb, var(--fg) 65%, var(--bg));
    --sq-faint: color-mix(in srgb, var(--fg) 45%, var(--bg));
    position: fixed; inset: 0; background: var(--bg);
    font-family: var(--font-app); color: var(--fg); overflow: hidden;
  }
  .stage { position: absolute; inset: 0; }
  .stage :global(.sq-canvas) { display: block; width: 100%; height: 100%; touch-action: none; }
  .stage :global(.sq-labels) { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .stage :global(.sq-lab) { position: absolute; left: 0; top: 0; white-space: nowrap; will-change: transform, opacity; pointer-events: auto; cursor: pointer;
    text-shadow: 0 0 3px var(--bg), 0 0 8px var(--bg), 0 0 16px var(--bg); }
  .stage :global(.sq-node .t) { font: 400 11px/1.2 var(--font-mono); letter-spacing: -0.01em; color: var(--sq-muted); }
  .stage :global(.sq-node:hover .t) { color: var(--fg); }
  .stage :global(.sq-node.memory .t) { font: 500 12px/1.2 var(--font-app); color: var(--fg); }
  .stage :global(.sq-node .q), .stage :global(.sq-node .c) { display: none; }
  .stage :global(.sq-node.full .c:not(:empty)) { display: block; margin-bottom: 6px; font: 600 9px/1 var(--font-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--sq-faint); }
  .stage :global(.sq-node.full .t) { display: none; }
  .stage :global(.sq-node.full .q) { display: block; white-space: normal; width: max-content; max-width: 32ch;
    font: 400 13px/1.45 var(--font-app); color: color-mix(in srgb, var(--fg) 82%, var(--bg)); }
  .stage :global(.sq-node .q b) { font-weight: 600; color: var(--fg); }

  .strip { position: absolute; top: 18px; left: var(--app-gutter, 34px); right: var(--app-gutter, 34px); display: flex; flex-wrap: wrap; gap: 4px; }
  .find { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 11px; border: 0; border-radius: 999px;
    background: color-mix(in srgb, var(--bg) 70%, transparent); color: var(--fg); font: 500 13px/1 var(--font-app); cursor: pointer; }
  .find:hover { background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  .k { font: 500 10px/1 var(--font-mono); color: var(--sq-faint); }
  .find { margin-left: auto; color: var(--sq-muted); }
  .app { display: inline-flex; align-items: center; height: 30px; padding: 0 11px; border-radius: 999px; color: var(--sq-muted); font: 500 13px/1 var(--font-app); text-decoration: none; }
  .app:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }

  .hud { position: absolute; top: 72px; left: var(--app-gutter, 34px); width: min(460px, calc(100% - 32px)); display: flex; flex-direction: column; gap: 9px;
    pointer-events: none; text-shadow: 0 0 8px var(--bg), 0 0 18px var(--bg); }
  .eyebrow { font: 600 10px/1 var(--font-app); letter-spacing: 0.24em; text-transform: uppercase; color: var(--sq-muted); }
  h1 { margin: 0; font: 500 clamp(28px, 2.5vw, 36px)/1.05 var(--font-app); letter-spacing: -0.03em; }
  .hud p { margin: 0; max-width: 44ch; font: 400 14.5px/1.5 var(--font-app); color: color-mix(in srgb, var(--fg) 80%, var(--bg)); }

  .search { position: absolute; top: 62px; left: calc(var(--app-gutter, 34px) - 8px); width: min(480px, calc(100% - 32px)); z-index: 2;
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
  .row .a { font: 500 11px/1 var(--font-mono); overflow: hidden; text-overflow: ellipsis; }
  .row .a.client { color: var(--sq-muted); }
  .row .x { overflow: hidden; text-overflow: ellipsis; color: color-mix(in srgb, var(--fg) 82%, var(--bg)); }
  .row:nth-last-child(2) { opacity: .7; } .row:nth-last-child(3) { opacity: .5; } .row:nth-last-child(4) { opacity: .36; }
  .row:nth-last-child(5) { opacity: .25; } .row:nth-last-child(6) { opacity: .16; }
  .feed:hover .row { opacity: .45; } .feed .row:hover { opacity: 1; } .row:hover .x { color: var(--fg); }
  .hints { position: absolute; right: var(--app-gutter, 34px); bottom: 26px; margin: 0; display: flex; gap: 18px; pointer-events: none;
    font: 600 10px/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--sq-faint); }
  .notice { position: absolute; right: var(--app-gutter, 34px); bottom: 50px; max-width: 46ch; margin: 0; padding: 9px 12px; border-radius: 8px;
    background: color-mix(in srgb, var(--fg) 8%, var(--bg)); font: 400 13px/1.4 var(--font-app); color: var(--fg); }
  .error { position: absolute; top: 80px; left: var(--app-gutter, 34px); font: 400 13px/1.5 var(--font-app); color: var(--sq-muted); }
  @media (max-width: 700px) {
    .row { grid-template-columns: 72px minmax(0, 1fr); } .row .w { display: none; }

  }
</style>
