<script lang="ts">
  import PilotIdentityGlyph from "./PilotIdentityGlyph.svelte";
  import { SELECTOR_RATIO } from "./pilotSessionScenes";

  const activities = ["draft", "idle", "active", "working"] as const;
  let activity = $state<typeof activities[number]>("draft");
  let shape = $state<"triangle" | "circle">("triangle");
  let selected = $state<string | null>("session");
  let hovered = $state<string | null>(null);
  let ratio = $state(SELECTOR_RATIO);
  let zoom = $state(1);
  const nodes = [
    { id: "session", title: "Dana × Arbor", pilot: true, x: 200, y: 90, addedAt: "2026-09-14T09:30:00Z", updatedAt: "2026-09-14T09:41:00Z" },
    { id: "hardening", title: "Arbor hardening", pilot: true, x: 480, y: 70, addedAt: "2026-09-02T11:15:00Z" },
    { id: "arbor", title: "Arbor OS", pilot: false, x: 720, y: 120, addedAt: "2026-09-04T16:30:00Z", updatedAt: "2026-09-11T14:02:00Z" },
    { id: "dana", title: "Dana Reed", pilot: false, x: 350, y: 225, addedAt: "2026-09-01T08:20:00Z", updatedAt: "2026-09-14T09:35:00Z" },
  ];
  const date = (n: typeof nodes[number]) => n.updatedAt ?? n.addedAt;
  // Fixed UTC fixtures keep the visual comparison identical across machines.
  const dateLabel = (n: typeof nodes[number]) => new Date(date(n)).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
  }).replace(",", "");
  const current = $derived(nodes.find(n => n.id === selected));
  const status = (id: string) => id === "session" ? activity : "idle" as const;
  const title = (n: typeof nodes[number]) => n.id === "session" && activity === "draft" ? "New session" : n.title;
  const stateLabel = (phase: typeof activity) => phase === "draft" ? "New session" : phase;
  const outlined = (id: string) => selected === id || hovered === id;
  function edge(a: typeof nodes[number], b: typeof nodes[number]): string {
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    const radius = (n: typeof a, ux: number, uy: number) => {
      if (outlined(n.id) || status(n.id) === "working") return 9 * ratio;
      if (!n.pilot || shape === "circle") return 9;
      // Intersect the ray with the three sides of the centered triangle.
      return Math.min(...[[Math.sqrt(3) * ux + uy, 9], [-Math.sqrt(3) * ux + uy, 9], [-uy, 4.5]]
        .filter(([direction]) => direction > 0).map(([direction, distance]) => distance / direction));
    };
    const ar = radius(a, dx / length, dy / length), br = radius(b, -dx / length, -dy / length);
    return `M ${a.x + dx / length * ar} ${a.y + dy / length * ar} L ${b.x - dx / length * br} ${b.y - dy / length * br}`;
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape") { selected = null; hovered = null; } }} />

<section class="identity-workbench" aria-label="Pilot identity comparison">
  <header>
    <div><h1>When a Pilot settles</h1><p>{shape === "triangle" ? "A downward triangle for Pilot sessions." : "A dot inside a thin ring for Pilot sessions."} Selection adds an outer circle.</p></div>
    <div class="states" aria-label="Pilot shape">
      <button aria-pressed={shape === "triangle"} onclick={() => shape = "triangle"}>Triangle</button>
      <button aria-pressed={shape === "circle"} onclick={() => shape = "circle"}>Circle</button>
    </div>
    <label>Selector ratio <output>{ratio.toFixed(3)}</output><input aria-label="Selector ratio" type="range" min="1.3" max="2.3" step="0.001" bind:value={ratio} /></label>
    <button class="reset" onclick={() => ratio = SELECTOR_RATIO}>Reset to φ</button>
  </header>

  <table class="comparison" aria-label="Activity and selection comparison">
    <thead><tr><td></td>{#each activities as phase}<th scope="col">{phase === "draft" ? "New session" : `${phase} Pilot`}</th>{/each}<th scope="col">Ordinary node</th></tr></thead>
    <tbody>
      {#each [false, true] as isSelected}
        <tr><th scope="row">{isSelected ? "Selected" : "Unselected"}</th>
          {#each activities as phase}<td><PilotIdentityGlyph {shape} state={phase} size={48} {ratio} selected={isSelected} /></td>{/each}
          <td><PilotIdentityGlyph {shape} size={48} {ratio} pilot={false} selected={isSelected} /></td>
        </tr>
      {/each}
    </tbody>
  </table>

  <div class="graph-toolbar">
    <span class="caption">Pilot state</span>
    <div class="states" aria-label="Pilot activity">
      {#each activities as option}
        <button aria-pressed={activity === option} onclick={() => activity = option}>{stateLabel(option)}</button>
      {/each}
    </div>
    <label>Zoom <input aria-label="Graph zoom" type="range" min="0.6" max="1.3" step="0.05" bind:value={zoom} /></label>
  </div>
  <svg class="graph" viewBox="0 0 900 290" aria-label="Pilot identity graph">
    <g transform={`translate(${450 * (1 - zoom)} ${145 * (1 - zoom)}) scale(${zoom})`}>
      {#each Array.from({ length: 24 }, (_, i) => ({ x: 30 + (i * 137) % 840, y: 15 + (i * 79) % 260 })) as n}
        <path class="faint-edge" d={`M ${n.x} ${n.y} L 350 225`} /><circle class="faint-node" cx={n.x} cy={n.y} r="3" />
      {/each}
      {#each [[nodes[3], nodes[0]], [nodes[3], nodes[1]], [nodes[3], nodes[2]], [nodes[0], nodes[2]], [nodes[1], nodes[2]]] as [a, b]}
        <path class="edge" class:live-edge={(a.id === "session" || b.id === "session") && activity !== "idle"}
          class:flow={(a.id === "session" || b.id === "session") && activity !== "idle"} d={a.id === "session" ? edge(b, a) : edge(a, b)} />
      {/each}
      {#each nodes as n}
        <g class="graph-node" role="button" tabindex="0" aria-label={title(n)} aria-pressed={selected === n.id}
          onmouseenter={() => hovered = n.id} onmouseleave={() => hovered = null}
          onclick={() => selected = n.id} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selected = n.id; } }}>
          <circle class="hit" cx={n.x} cy={n.y} r="26" />
          <g transform={`translate(${n.x - 24} ${n.y - 24})`}>
            <PilotIdentityGlyph {shape} pilot={n.pilot} state={status(n.id)} selected={outlined(n.id)} size={48} {ratio} />
          </g>
          <text class:live-title={n.id === "session" && activity !== "idle"} x={n.x} y={n.y + 9 * ratio + 20}>{title(n)}</text>
        </g>
      {/each}
    </g>
  </svg>
  <p class="hint">Connections move toward new, active and working Pilots. The blinking cursor means ready to type. Click to select; Esc clears selection.</p>

  <div class="list-and-tab">
    <div>
      <div class="caption">Search results</div>
      <div class="results" aria-label="Search list comparison">
        {#each nodes as n}
          <button class="result" class:chosen={selected === n.id} class:active-pilot={n.pilot && status(n.id) !== "idle"} aria-pressed={selected === n.id} onclick={() => selected = n.id}>
            <span class="result-title"><PilotIdentityGlyph {shape} pilot={n.pilot} state={status(n.id)} size={28} {ratio} /><span>{title(n)}</span></span>
            <small class="result-tag">{n.pilot ? "Pilot" : "Entity"}</small>
            <time datetime={date(n)} aria-label={`${n.updatedAt ? "Updated" : "Added"} ${dateLabel(n)}`}>{dateLabel(n)}</time>
          </button>
        {/each}
      </div>
    </div>
    <div>
      <div class="caption">Text tab · status without selection</div>
      <div class="text-tab">
        {#if current}
          <div class="tab-header">
            <PilotIdentityGlyph {shape} pilot={current.pilot} state={status(current.id)} size={28} {ratio} />
            <strong>{title(current)}</strong><span>{current.pilot ? status(current.id) === "idle" ? "Closed" : status(current.id) === "draft" ? "Ready to type" : status(current.id) : "Entity"}</span>
          </div>
          <p>{current.pilot ? status(current.id) === "draft" ? "Start a conversation with this context." : "A saved conversation, with its context and history intact." : "A regular node in the vault."}</p>
        {:else}<p class="empty">Select a node to preview its text tab.</p>{/if}
      </div>
      <div class="small-sizes"><span>At small sizes</span>{#each [20, 28, 36] as size}<PilotIdentityGlyph {shape} {size} {ratio} state={activity} />{/each}</div>
    </div>
  </div>
</section>

<style>
  .identity-workbench { --pilot: var(--activity); height: 100%; overflow: auto; box-sizing: border-box; padding: 28px 32px; color: var(--text-strong); background: var(--bg); font: 16px/1.5 var(--font-app); }
  header { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  header > div { margin-right: auto; }
  h1 { font-size: 20px; font-weight: 500; margin: 0 0 4px; }
  p { margin: 0; color: var(--text-muted); }
  header p { font-size: 14px; }
  button { font: inherit; cursor: pointer; color: inherit; }
  button:focus-visible, .graph-node:focus-visible { outline: 2px solid var(--pilot); outline-offset: 3px; }
  label, .reset, .caption, .hint, .small-sizes { font: 11px/1.5 var(--font-mono); color: var(--text-muted); }
  label { display: flex; align-items: center; gap: 8px; }
  input { width: 90px; accent-color: var(--pilot); }
  output { min-width: 40px; }
  .reset { background: var(--well); border: 0; border-radius: 5px; padding: 6px 10px; }
  .comparison { width: 100%; table-layout: fixed; border-spacing: 0; padding: 16px 0; margin: 16px 0; border-block: 1px solid var(--rule); text-align: center; }
  .comparison th { font-size: 13px; font-weight: 400; text-transform: capitalize; padding: 4px; }
  .comparison tbody th { color: var(--text-muted); text-align: left; }
  .comparison td { padding: 2px; }
  .comparison td :global(svg) { margin: auto; }
  .graph-toolbar { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  .caption { text-transform: uppercase; letter-spacing: 1px; }
  .states { display: flex; gap: 4px; }
  .states button { font: 11px var(--font-mono); text-transform: uppercase; border: 0; border-radius: 5px; padding: 6px 12px; background: transparent; color: var(--text-muted); }
  .states button[aria-pressed="true"] { background: var(--well); color: var(--text-strong); }
  .graph-toolbar label { margin-left: auto; }
  .graph { display: block; width: 100%; max-height: 340px; min-height: 200px; color: var(--text-strong); }
  .faint-edge { stroke: var(--text-faint); opacity: .14; }
  .faint-node { fill: var(--text-muted); opacity: .18; }
  .edge { fill: none; stroke: var(--text-muted); opacity: .5; stroke-width: 1; }
  .edge.live-edge { stroke: var(--pilot); stroke-dasharray: 7 7; }
  .flow { animation: flow 850ms linear infinite; }
  @keyframes flow { to { stroke-dashoffset: -28; } }
  .graph-node { cursor: pointer; }
  .hit { fill: transparent; }
  text { fill: var(--text-strong); text-anchor: middle; font: 14px var(--font-app); stroke: var(--bg); stroke-width: 4px; paint-order: stroke; }
  .live-title { fill: var(--pilot); }
  .hint { text-align: center; margin: 4px 0 24px; }
  .list-and-tab { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 24px; }
  .list-and-tab .caption { margin-bottom: 12px; }
  .results, .text-tab { border: 1px solid var(--rule); border-radius: 12px; overflow: hidden; }
  .results { padding: 8px; container-type: inline-size; }
  .result { display: grid; grid-template-columns: minmax(0, 1fr) 112px 128px; gap: 24px; align-items: center; width: 100%; box-sizing: border-box; height: 42px; padding: 10px 14px; background: transparent; border: 0; border-radius: 8px; text-align: left; }
  .result-title { display: flex; align-items: center; gap: 10px; min-width: 0; font: 650 var(--fs-chip)/1.4 var(--font-app); }
  .result-title :global(svg) { margin-block: -3px; }
  .result-title > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-tag, .result time { font: 500 11px/1.5 var(--font-mono); letter-spacing: .08em; color: var(--text-muted); white-space: nowrap; }
  .result-tag { text-transform: uppercase; }
  .result time { text-align: right; font-variant-numeric: tabular-nums; }
  .chosen { --glyph-bg: var(--text-strong); background: var(--text-strong); color: var(--bg); }
  .chosen.active-pilot { background: var(--activity); --glyph-bg: var(--activity); --pilot: var(--bg); }
  .chosen small, .chosen time { color: var(--bg); opacity: .7; }
  .tab-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--rule); font: 10px var(--font-mono); text-transform: uppercase; letter-spacing: 1px; }
  .tab-header strong { flex: 1; font-weight: 500; }
  .tab-header > span { color: var(--text-muted); }
  .text-tab p { padding: 16px 20px; }
  .small-sizes { display: flex; align-items: center; gap: 16px; margin-top: 16px; }
  @container (max-width: 560px) {
    .result { grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; height: 62px; padding: 8px 12px; }
    .result-title { grid-column: 1 / -1; }
    .result-tag, .result time { font-size: 10px; }
  }
  @media (max-width: 850px) { .identity-workbench { padding: 20px; } .list-and-tab { grid-template-columns: 1fr; } }
  @media (prefers-reduced-motion: reduce) { .flow { animation: none; } }
</style>
