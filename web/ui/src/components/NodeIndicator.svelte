<script lang="ts">
  import { SELECTOR_RATIO } from "../../../../lib/pilotChatTypes";
  import { TRIANGLE_PATH, pilotHollow, type PilotVisualPhase } from "../lib/pilotAppearance";

  // The entire r=9 glyph is identity/status, shared by lists and panels.
  // Only the outer r=9*ratio ring means selection (or working motion).
  const { pilot = true, memory = false, shape = "triangle", state = "idle", selected = false, size = 40, ratio = SELECTOR_RATIO }:
    { pilot?: boolean; memory?: boolean; shape?: "triangle" | "circle"; state?: PilotVisualPhase; selected?: boolean; size?: number; ratio?: number } = $props();
</script>

<svg width={size} height={size} viewBox="-24 -24 48 48" aria-hidden="true"
  class:live={pilot && state !== "idle"} class="identity-glyph">
  {#if selected}
    <circle class="selection" r={9 * ratio} />
  {/if}
  {#if pilot && state === "working"}
    <circle class="spinner" r={9 * ratio} />
  {/if}
  {#if pilot}
    {#if shape === "triangle"}
      <path class="pilot-triangle" class:hollow={pilotHollow(state)} d={TRIANGLE_PATH} />
    {:else}
      <circle class="pilot-ring" r="9" />
      {#if !pilotHollow(state)}<circle class="pilot-dot" r="5" />{/if}
    {/if}
    {#if state === "interrupted"}<path class="status-mark" d="M -1.5 -2 V 2 M 1.5 -2 V 2" />{/if}
    {#if state === "failed"}<path class="status-mark" d="M 0 -2 V 0 M 0 1.5 V 2.5" />{/if}
    {#if state === "draft"}<path class="caret" d={shape === "triangle" ? "M 0 -2 L 0 3.5" : "M 0 -5 L 0 5"} />{/if}
  {:else if memory}
    <path class="memory" d="M 0 -9 L 9 0 L 0 9 L -9 0 Z" />
  {:else}
    <circle class="ordinary" class:selected r="9" />
  {/if}
</svg>

<style>
  svg { display: block; flex: none; overflow: visible; color: inherit; }
  .live { color: var(--pilot, var(--activity)); }
  circle, path { stroke-width: 1.25; vector-effect: non-scaling-stroke; }
  .selection { fill: none; stroke: currentColor; opacity: .6; }
  .pilot-ring { fill: var(--glyph-bg, var(--bg)); stroke: currentColor; }
  .memory { fill: var(--glyph-bg, var(--bg)); stroke: currentColor; }
  .pilot-dot, .ordinary { fill: currentColor; }
  .pilot-triangle { fill: currentColor; stroke: currentColor; stroke-linejoin: round; }
  .pilot-triangle.hollow { fill: var(--glyph-bg, var(--bg)); }
  .status-mark { fill: none; stroke: currentColor; }
  .caret { fill: none; stroke: currentColor; animation: blink 1s steps(1) infinite; }
  .ordinary.selected { fill: var(--glyph-bg, var(--bg)); stroke: currentColor; }
  .spinner { fill: none; stroke: currentColor; stroke-dasharray: 24 68; transform-origin: 0 0; animation: orbit 1s linear infinite; }
  @keyframes orbit { to { transform: rotate(360deg); } }
  @keyframes blink { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .spinner, .caret { animation: none; } }
</style>
