<script lang="ts">
  import { agentGlyph, type AgentVisualState } from "../lib/agentAppearance";
  const { state = "done", selected = false, size = 28 }: { state?: AgentVisualState; selected?: boolean; size?: number } = $props();
  const glyph = $derived(agentGlyph(state, selected));
</script>
<svg width={size} height={size} viewBox="-20 -20 40 40" aria-hidden="true" class:active={glyph.active} class:live={glyph.live} data-agent-state={state}>
  {#if glyph.outer}<rect class="outer" class:spin={glyph.spin} class:filled={glyph.inverted} x={-glyph.outerRadius} y={-glyph.outerRadius} width={glyph.outerRadius * 2} height={glyph.outerRadius * 2} />{/if}
  <rect class="inner" class:cutout={glyph.inverted} class:pulse={glyph.pulse} x={-glyph.innerRadius} y={-glyph.innerRadius} width={glyph.innerRadius * 2} height={glyph.innerRadius * 2} />
</svg>
<style>
  svg { display: block; flex: none; overflow: visible; color: inherit; }
  .active { color: var(--agent, var(--activity)); }
  .outer { fill: none; stroke: currentColor; stroke-width: 1.25; vector-effect: non-scaling-stroke; }
  .inner, .filled { fill: currentColor; } .cutout { fill: var(--glyph-bg, var(--bg)); }
  .spin { transform-origin: 0 0; animation: spin 2.4s linear infinite; }
  .pulse { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .spin, .pulse { animation: none; } }
</style>
