<script lang="ts">
  import { onMount } from "svelte";
  import AgentIndicator from "../components/AgentIndicator.svelte";
  import NodeIndicator from "../components/NodeIndicator.svelte";
  import { AGENT_STATES, drawAgentIndicator, type AgentVisualState } from "../lib/agentAppearance";
  let selected = $state(false), agentState = $state<AgentVisualState>("running");
  let canvas: HTMLCanvasElement;
  onMount(() => {
    let frame: number;
    const draw = (now: number) => {
      const ctx = canvas.getContext("2d")!;
      const style = getComputedStyle(canvas), ink = style.color, bg = style.getPropertyValue("--bg"), accent = style.getPropertyValue("--activity");
      const dpr = devicePixelRatio || 1;
      if (canvas.width !== 800 * dpr) { canvas.width = 800 * dpr; canvas.height = 160 * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, 800, 160);
      AGENT_STATES.forEach((s, i) => { drawAgentIndicator(ctx, 100 + i * 200, 65, 1.8, s, selected, now, matchMedia("(prefers-reduced-motion: reduce)").matches, ink, bg, accent); ctx.fillStyle = ink; ctx.font = "14px sans-serif"; ctx.textAlign = "center"; ctx.fillText(s, 100 + i * 200, 125); });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw); return () => cancelAnimationFrame(frame);
  });
</script>
<section aria-label="Agent indicator workbench">
  <h1>Pilots are triangles. Agents are squares.</h1>
  <p>From “Search List States”: running · waiting · turn finished · stopped. Finished turns remain active red; stopped is settled ink. These are the production indicators, not separate mock drawings.</p>
  <label><input type="checkbox" bind:checked={selected} /> Selected node</label>
  <h2>Graph · canvas renderer</h2><canvas bind:this={canvas} style="width:100%;max-width:800px;height:auto;aspect-ratio:5" aria-label="All four agent states">Agent states</canvas>
  <h2>List and header · SVG renderer</h2>
  <div class="matrix">{#each AGENT_STATES as s}<div><strong>{s}</strong>{#each [40, 28, 16, 12] as size}<AgentIndicator state={s} {selected} {size} />{/each}</div>{/each}</div>
  <h2>Search list · selection and dark-row contrast</h2>
  <div class="controls">{#each AGENT_STATES as s}<button aria-pressed={agentState === s} onclick={() => agentState = s}>{s}</button>{/each}</div>
  <div class="results">
    <div class="row"><NodeIndicator state="active" size={28} /><span>Dana × Arbor</span><small>Pilot</small></div>
    <button class="row chosen" onclick={() => selected = !selected}><AgentIndicator state={agentState} size={28} /><span>Arbor summary <small>from Dana × Arbor</small></span><small>Agent · {agentState}</small></button>
    {#if agentState === "done"}<div class="row"><NodeIndicator pilot={false} size={28} /><span>Arbor research — summary</span><small>Node</small></div>{/if}
  </div>
  <h2>Agent monitor header</h2><div class="row"><AgentIndicator state={agentState} size={28} /><strong>Arbor summary</strong><span>{agentState === "waiting" ? "Needs you" : agentState === "done" ? "Turn finished" : agentState}</span><small>Claude Code · provider model</small></div>
  <p>Failed and disconnected workers use the stopped glyph with an explicit status label. Reduced-motion preferences stop rotation and pulsing.</p>
</section>
<style>
  section { height: 100%; overflow: auto; box-sizing: border-box; padding: 32px; color: var(--text-strong); background: var(--bg); font: var(--type-body); }
  h1 { font-size: 22px; } h2 { font: var(--type-meta); margin: 28px 0 12px; } p, small { color: var(--text-muted); }
  .matrix { display: flex; gap: 60px; flex-wrap: wrap; } .matrix > div { display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .controls { display: flex; gap: 12px; margin-bottom: 16px; } button { cursor: pointer; font: inherit; color: inherit; background: none; border: 1px solid var(--rule); border-radius: 8px; padding: 8px 12px; }
  button[aria-pressed="true"] { color: var(--activity); } .results { max-width: 900px; border: 1px solid var(--rule); border-radius: 12px; padding: 8px; }
  .row { display: flex; align-items: center; gap: 16px; padding: 12px; width: 100%; box-sizing: border-box; text-align: left; }
  .row > span:first-of-type { flex: 1; } .chosen { background: var(--text-strong); color: var(--bg); --glyph-bg: var(--text-strong); } .chosen small { color: inherit; opacity: .7; }
</style>
