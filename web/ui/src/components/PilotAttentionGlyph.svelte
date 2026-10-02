<script lang="ts">
  import NodeIndicator from "./NodeIndicator.svelte";
  import type { PilotVisualPhase } from "../lib/pilotAppearance";
  import { tooltip } from "../lib/tooltip";
  // `tip` describes the status the glyph draws; the row that owns the glyph
  // still names it, so the shape is never the only carrier of the meaning.
  let { phase, state = "idle", size = 32, pulse = true, tip }: { phase?: PilotVisualPhase; state?: "waiting" | "running" | "idle"; size?: number; pulse?: boolean; tip?: string } = $props();
</script>
<span class="glyph" style:width={`${size}px`} style:height={`${size}px`} aria-hidden="true" use:tooltip={tip}>
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
