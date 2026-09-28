<script lang="ts">
  import { tick, untrack } from "svelte";
  import { TRIANGLE_PATH } from "../lib/pilotAppearance";
  import PilotAttentionGlyph from "./PilotAttentionGlyph.svelte";
  let { scene = "overview" }: { scene?: string } = $props();
  const initial = untrack(() => scene);
  type Pilot = { id: string; title: string; model: string; topic: string; state: "waiting" | "running" | "idle"; activity: string; question?: string; path?: string; x: number; y: number; reply?: string };
  const fixtures: Pilot[] = [
    { id: "atlas", title: "ATLAS", model: "Astra", topic: "Severity prototype", state: "waiting", activity: "Needs permission", question: "The prototype worker needs read access to the project's Python runtime. You can allow it here; I’ll pass your decision on.", path: "/Users/demo/.local/share/uv/python/cpython-3.12.12-macos-aarch64-none", x: 340, y: 205 },
    { id: "paper", title: "ICLR paper", model: "Astra", topic: "Check paper results", state: "waiting", activity: "Has a question", question: "The results worker needs a reference dataset. Which should I ask it to use?", x: 670, y: 350 },
    { id: "brain", title: "BigBrain", model: "Terra", topic: "Image attachments", state: "running", activity: "Testing paste and saved history", x: 285, y: 445 },
    { id: "research", title: "Research", model: "Astra", topic: "Forecasting literature", state: "running", activity: "Reading three relevant papers", x: 815, y: 190 },
  ];
  let pilots = $state<Pilot[]>(initial === "empty" ? [] : fixtures.map(a => initial === "quiet" ? { ...a, state: "running", activity: "Working on the next step", question: undefined, path: undefined } : { ...a }));
  if (initial === "many") pilots = [...fixtures, ...Array.from({ length: 8 }, (_, i): Pilot => ({ id: `extra-${i}`, title: ["Compare evaluation methods", "Review the benchmark", "Update project notes", "Check the simulation"][i % 4]!, model: i % 2 ? "Terra" : "Astra", topic: "Research", state: "running", activity: "Working through the source material", x: 155 + (i % 4) * 210, y: 275 + Math.floor(i / 4) * 270 }))];
  let open = $state(true), selected = $state<string | null>(null), conversation = $state(false), reply = $state("");
  let pulse = $state(true), trigger = $state<HTMLButtonElement>(), pane = $state<HTMLElement>(), body = $state<HTMLElement>();
  const waiting = $derived(pilots.filter(a => a.state === "waiting").length);
  const active = $derived(pilots.find(a => a.id === selected));
  const dots = Array.from({ length: 66 }, (_, i) => ({ x: 110 + (i * 137 % 790), y: 90 + (i * 89 % 480), r: i % 7 === 0 ? 3.2 : 1.7 }));
  async function preview(id: string) {
    selected = id; reply = "";
    await tick(); pane?.querySelector<HTMLButtonElement>(`[data-pilot="${id}"]`)?.focus();
  }
  async function toggle() {
    open = !open;
    if (open) { await tick(); if (selected) pane?.querySelector<HTMLButtonElement>(`[data-pilot="${selected}"]`)?.focus(); else pane?.focus(); }
    else trigger?.focus();
  }
  async function enter(id: string) {
    selected = id; conversation = true; open = false; reply = "";
    await tick(); body?.focus();
  }
  function respond(value: string) {
    if (!active || !value.trim()) return;
    const id = active.id;
    pilots = pilots.map(a => a.id === id ? { ...a, state: "running", activity: "Continuing with your answer", reply: value, question: undefined, path: undefined } : a);
    reply = "";
  }
  function keyboard(e: KeyboardEvent) {
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement;
    if (el?.matches("input, textarea, select") || el?.isContentEditable) return;
    if (e.key === "a") { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) void toggle(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); if (open) { open = false; trigger?.focus(); } else { selected = null; conversation = false; } }
    else if (open && ["j", "k", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault(); e.stopImmediatePropagation(); if (!pilots.length) return;
      const i = pilots.findIndex(a => a.id === selected);
      const next = e.key === "Home" ? 0 : e.key === "End" ? pilots.length - 1 : i < 0 ? (["k", "ArrowUp"].includes(e.key) ? pilots.length - 1 : 0) : Math.max(0, Math.min(pilots.length - 1, i + (["j", "ArrowDown"].includes(e.key) ? 1 : -1)));
      void preview(pilots[next]!.id);
    } else if (open && e.key === "Enter" && active) { e.preventDefault(); e.stopImmediatePropagation(); void enter(active.id); }
  }
  function outside(e: PointerEvent) {
    if (open && e.target instanceof Node && !pane?.contains(e.target) && !trigger?.contains(e.target)) open = false;
  }
</script>

<svelte:window onkeydowncapture={keyboard} onpointerdown={outside} />
<div class="desk" class:pane-open={open}>
  <header class="chrome"><div class="search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><span>search everything…</span><kbd>/</kbd></div>
    <button class="pilots-trigger" class:pressed={open} bind:this={trigger} onclick={toggle} aria-label={`Pilots${waiting ? `, ${waiting} need you` : ""}`} aria-expanded={open} aria-controls="pilots-pane" aria-keyshortcuts="a" title="Pilots"><svg width="22" height="22" viewBox="-12 -12 24 24" aria-hidden="true"><path d={TRIANGLE_PATH} fill="currentColor" /></svg>{#if waiting}<i class="attention-dot" aria-hidden="true"></i>{/if}</button>
  </header>
  <div class="graph-label">YOUR GRAPH <span>{pilots.length} active pilots</span></div>
  <svg class="graph" viewBox="0 0 1050 650" role="group" aria-label="Graph with active pilots; pilots needing you have a breathing selector">
    <g class="background">
      {#each dots as dot, i}<line x1={dot.x} y1={dot.y} x2={dots[(i + 13) % dots.length].x} y2={dots[(i + 13) % dots.length].y} /><circle cx={dot.x} cy={dot.y} r={dot.r} />{/each}
    </g>
    {#each pilots as pilot}
      <g transform={`translate(${pilot.x},${pilot.y})`} class="pilot-node" class:chosen={selected === pilot.id}>

        {#if selected === pilot.id}<circle class="selection" r="34" />{/if}
        <foreignObject x="-22" y="-22" width="44" height="44"><PilotAttentionGlyph state={pilot.state} size={44} {pulse} /></foreignObject>
        <text y="43" text-anchor="middle">{pilot.title}</text>
        {#if pilot.state === "waiting"}<text y="60" text-anchor="middle" class="needs-label">Needs you</text>{/if}
        <foreignObject x="-90" y="-28" width="180" height="96"><button class="node-hit" aria-label={`Open ${pilot.title}`} onclick={() => enter(pilot.id)}></button></foreignObject>
      </g>
    {/each}
  </svg>
  {#if open}
    <section id="pilots-pane" class="pilots-pane" aria-label="Active pilots" tabindex="-1" bind:this={pane}>
      <div class="pane-heading"><div><h2>Pilots <span>{pilots.length}</span></h2></div><button class="close" aria-label="Close pilots" onclick={() => { open = false; trigger?.focus(); }}>×</button></div>
      <div class="roster" role="list" aria-label="Active pilot list">
        {#each pilots as pilot}<div role="listitem"><button class="pilot-row" class:selected={selected === pilot.id} data-pilot={pilot.id} onclick={() => preview(pilot.id)} ondblclick={() => enter(pilot.id)} onfocus={() => { if (selected !== pilot.id) { selected = pilot.id; reply = ""; } }} aria-pressed={selected === pilot.id}>
          <PilotAttentionGlyph state={pilot.state} size={32} {pulse} /><span class="row-copy"><strong>{pilot.title}</strong><span class="metadata">{pilot.model}</span></span>
          {#if pilot.state === "waiting"}<i class="attention-dot" aria-label="Needs you"></i>{/if}

        </button></div>{:else}<div class="empty"><PilotAttentionGlyph size={35} /><p>Your active pilots will appear here.</p><span>Your Pilots bring questions and permissions here, including requests from their workers.</span></div>{/each}
      </div>
      {#if active}<div class="pilot-preview"><span class="eyebrow">{active.state === "waiting" ? "NEEDS YOU" : "LATEST ACTIVITY"}</span><p>{active.question ?? (active.reply ? `Your answer: ${active.reply}. I’ve passed it to the worker.` : active.activity + ". I’ll ask if I need your input.")}</p><button class="open-chat" onclick={() => enter(active.id)}>Open conversation <span>↵</span></button></div>{/if}
      <footer><span><kbd>j</kbd> <kbd>k</kbd> / <kbd>↑</kbd> <kbd>↓</kbd> explore</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></footer>
    </section>
  {/if}
  {#if conversation && active}
    <section class="conversation" aria-label="Pilot conversation" tabindex="-1" bind:this={body}>
      <header><PilotAttentionGlyph state={active.state} size={32} {pulse} /><strong>{active.title}</strong><span>{active.model} · {active.topic}</span><button aria-label="Close conversation" onclick={() => { conversation = false; selected = null; }}>×</button></header>
      <div class="conversation-body"><p class="eyebrow">{active.state === "waiting" ? "NEEDS YOUR INPUT" : "CURRENT ACTIVITY"}</p><p>{active.question ?? (active.reply ? `Got it — ${active.reply.toLowerCase()}. I’ve passed your decision to the worker and will keep you updated.` : active.activity + ".")}</p>
        {#if active.path}<div class="permission"><span>Read access · prototype worker only</span><code>{active.path}</code><div class="actions"><button class="primary" onclick={() => respond("Read access allowed")}>Allow read access</button><button onclick={() => respond("Access declined; use another approach")}>Decline</button></div></div>
        {:else if active.question}<div class="actions"><button class="primary" onclick={() => respond("Use the original dataset")}>Original dataset</button><button onclick={() => respond("Use the revised dataset")}>Revised dataset</button></div>{/if}
        <form onsubmit={e => { e.preventDefault(); respond(reply); }}><input aria-label="Reply to pilot" bind:value={reply} placeholder="Continue the conversation…" /><button disabled={!reply.trim()}>Send ↵</button></form>
      </div>
    </section>
  {/if}
  <div class="experiment"><span>WORKBENCH · simulated pilots</span><label><input type="checkbox" bind:checked={pulse} /> Pulse when a Pilot needs you</label></div>
</div>

<style>
  .desk { position: relative; height: 100%; overflow: hidden; background: var(--bg); color: var(--text-strong); font: var(--type-body); container-type: inline-size; }
  button, input { font: inherit; } button { color: inherit; cursor: pointer; } button:focus-visible { outline: 2px solid var(--activity); outline-offset: 3px; } button:disabled { opacity: .4; cursor: default; }
  .chrome { display: flex; gap: 20px; align-items: center; padding: 26px 28px; position: relative; z-index: 3; }
  .search { display: flex; gap: 14px; align-items: center; flex: 1; min-width: 0; background: var(--surface); padding: 16px; border-radius: 12px; color: var(--text-muted); } .search kbd { margin-left: auto; }
  kbd { font: 11px var(--font-mono); color: var(--text-muted); } .pilots-trigger { position: relative; display: grid; place-items: center; flex: none; width: var(--size-icon-btn); height: var(--size-icon-btn); background: var(--surface); color: var(--icon); border: 0; border-radius: var(--r-full); padding: 0; } .pilots-trigger:hover, .pilots-trigger.pressed { box-shadow: inset 0 0 0 1px var(--rule); }
  .attention-dot { display: block; width: 7px; height: 7px; border-radius: 50%; background: var(--activity); flex: none; }
  .pilot-row > .attention-dot { margin-top: 9px; }
  .pilots-trigger > .attention-dot { position: absolute; top: 0; right: 0; box-shadow: 0 0 0 2px var(--bg); }
  .graph-label { position: absolute; top: 106px; left: 28px; font: 10px var(--font-mono); letter-spacing: 1.4px; color: var(--text-muted); } .graph-label span { margin-left: 14px; opacity: .7; letter-spacing: 0; }
  .graph { position: absolute; inset: 100px 0 20px; width: 100%; height: calc(100% - 120px); } .background { opacity: .19; } .background line { stroke: var(--rule); stroke-width: .6; } .background circle { fill: var(--text-muted); }
  .pane-open .graph { width: calc(100% - 390px); }
  .pilot-node { color: var(--pilot, var(--activity)); } .pilot-node text { fill: var(--text-muted); font: 12px var(--font-app); } .pilot-node .needs-label { fill: var(--activity); font: 10px var(--font-mono); } .node-hit { display: block; width: 100%; height: 100%; border: none; background: transparent; border-radius: 12px; }
  .selection { fill: color-mix(in srgb, var(--activity) 7%, transparent); stroke: var(--activity); stroke-width: .7; opacity: .6; } .chosen text { fill: var(--text-strong); }
  .pilots-pane { position: absolute; z-index: 5; top: 88px; right: 28px; width: 360px; max-width: calc(100% - 32px); background: var(--bg); border: 1px solid var(--rule); border-radius: 14px; box-shadow: 0 12px 40px #0000000c; overflow: hidden; outline: none; max-height: calc(100% - 140px); display: flex; flex-direction: column; }
  .pane-heading { display: flex; justify-content: space-between; align-items: flex-start; padding: 22px 22px 18px; } h2 { font-size: 17px; margin: 0; font-weight: 600; } h2 span { font: 12px var(--font-mono); color: var(--text-muted); margin-left: 8px; } .close { border: none; background: none; font-size: 22px; line-height: 20px; color: var(--text-muted); }
  .roster { overflow-y: auto; padding: 0 8px 8px; min-height: 90px; overscroll-behavior: contain; } .pilot-row { display: flex; align-items: flex-start; gap: 12px; padding: 15px 12px; width: 100%; border: none; border-radius: 8px; background: none; text-align: left; } .pilot-row:hover { background: var(--surface); } .pilot-row.selected { background: var(--surface); box-shadow: inset 2px 0 var(--activity); } .pilot-row:focus-visible { outline-offset: -2px; }
  .row-copy { flex: 1; min-width: 0; display: grid; gap: 6px; } .row-copy strong { font-size: 13px; font-weight: 550; } .metadata { font-size: 11px; color: var(--text-muted); }
  .pilot-preview { padding: 18px 22px; border-top: 1px solid var(--rule); } .eyebrow { font: 10px var(--font-mono); letter-spacing: 1px; color: var(--activity); } .pilot-preview p { font-size: 13px; line-height: 1.65; margin: 9px 0 14px; } .open-chat { display: flex; justify-content: space-between; width: 100%; background: transparent; border: none; padding: 0; font-size: 12px; color: var(--activity); }
  footer { display: flex; justify-content: space-between; flex: none; gap: 10px; padding: 13px 20px; border-top: 1px solid var(--rule); color: var(--text-muted); font-size: 10px; } footer kbd { font-size: 10px; }
  .empty { padding: 24px 16px 32px; display: grid; justify-items: center; text-align: center; color: var(--text-muted); } .empty p { font-size: 13px; } .empty span { font-size: 12px; max-width: 230px; line-height: 1.6; }
  .conversation { position: absolute; bottom: 50px; left: 28px; right: 28px; max-height: 54%; overflow: auto; background: var(--bg); border: 1px solid var(--rule); border-radius: 12px; box-shadow: 0 8px 30px #00000008; outline: none; }
  .conversation header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--rule); } .conversation header strong { font-size: 12px; font-weight: 550; } .conversation header span { font-size: 11px; color: var(--text-muted); } .conversation header button { margin-left: auto; background: none; border: none; font-size: 20px; }
  .conversation-body { max-width: 650px; padding: 16px 24px; margin: auto; font-size: 15px; line-height: 1.7; } .permission { display: grid; gap: 12px; } .permission > span { font-size: 12px; color: var(--text-muted); } code { font: 12px/1.7 var(--font-mono); overflow-wrap: anywhere; } .actions { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0; } .actions button { background: transparent; border: 1px solid var(--rule); border-radius: 5px; padding: 8px 12px; font-size: 12px; } .actions .primary { background: var(--text-strong); color: var(--bg); border-color: var(--text-strong); }
  form { display: flex; margin-top: 20px; border-top: 1px solid var(--rule); padding-top: 12px; } form input { flex: 1; min-width: 0; background: transparent; color: var(--text-strong); border: none; outline: none; font-size: 13px; padding: 7px 0; } form button { border: none; background: none; color: var(--text-muted); font-size: 11px; }
  .experiment { position: absolute; bottom: 14px; left: 28px; right: 28px; display: flex; justify-content: space-between; gap: 16px; align-items: center; color: var(--text-muted); font: 10px var(--font-mono); } .experiment label { display: flex; align-items: center; gap: 7px; font: 11px var(--font-app); } input[type=checkbox] { accent-color: var(--activity); }
  @container (max-width: 550px) { .chrome { padding: 20px 16px; gap: 10px; } .search { font-size: 12px; padding: 13px; } .search kbd { display: none; } .pilots-pane { right: 16px; top: 78px; } .conversation { left: 12px; right: 12px; bottom: 66px; max-height: 65%; } .conversation header { flex-wrap: wrap; gap: 8px; } .conversation header span { font-size: 10px; } .experiment { left: 16px; right: 16px; flex-wrap: wrap; gap: 6px; } .graph-label { left: 16px; } }
  @container (max-width: 850px) { .pane-open .graph { width: 100%; } }
</style>
