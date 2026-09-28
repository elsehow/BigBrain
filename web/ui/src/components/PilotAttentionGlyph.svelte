<script lang="ts">
  import NodeIndicator from "./NodeIndicator.svelte";
  import type { PilotVisualPhase } from "../lib/pilotAppearance";
  let { phase, state = "idle", size = 32, pulse = true }: { phase?: PilotVisualPhase; state?: "waiting" | "running" | "idle"; size?: number; pulse?: boolean } = $props();
</script>
<span class="glyph" style:width={`${size}px`} style:height={`${size}px`} aria-hidden="true">
  <NodeIndicator state={phase ?? (state === "running" ? "working" : state === "idle" ? "idle" : "active")} {size} />
  {#if state === "waiting"}<svg class="attention-ring" class:breathe={pulse} viewBox="-24 -24 48 48"><path d="M-20 -10v-10h10 M10 -20h10v10 M20 10v10h-10 M-10 20h-10v-10" /></svg>{/if}
</span>
<style>
  .glyph { display: inline-block; position: relative; flex: none; color: var(--mark); }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; opacity: .7; }
  path { fill: none; stroke: currentColor; stroke-width: 1.2; vector-effect: non-scaling-stroke; }
  .breathe { animation: breathe 3.6s cubic-bezier(.37, 0, .63, 1) infinite; will-change: opacity; }
  @keyframes breathe { 0%,100% { opacity: .3; } 50% { opacity: .9; } }
  @media (prefers-reduced-motion: reduce) { .breathe { animation: none; opacity: .8; } }
</style>
