<!-- A Desktop in the chrome: its cube from the field (lib/v2/wireMotion.ts),
     flat, in glass with a hairline in the text's colour. While it works it
     turns on the Desktop's own clock, so in step with its cube in the field.
     The glass covers what's behind it, so it's mixed over --cube-ground:
     whatever the cube sits on. -->
<script lang="ts">
  import { flatWire, wireClock } from "../lib/v2/wireMotion";
  let { id, working = false, size = 16 }: { id: string; working?: boolean; size?: number } = $props();
  let t = $state(0);
  $effect(() => {
    if (!working) { t = 0; return; }
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    const frame = () => { t = reduced.matches ? 0 : wireClock(id); raf = requestAnimationFrame(frame); };
    frame();
    return () => cancelAnimationFrame(raf);
  });
  const wire = $derived(flatWire(t));
</script>

<svg class="cube" width={size} height={size} viewBox="-1.8 -1.8 3.6 3.6" aria-hidden="true">
  {#each wire.blocks as b, i (i)}
    <path class="glass" d={b.faces} />
    <path class="line" d={b.edges} />
    {#if b.seams && wire.seam > 0}<path class="line" d={b.seams} opacity={wire.seam} />{/if}
  {/each}
</svg>

<style>
  .cube { flex: none; overflow: visible; }
  .glass { fill: color-mix(in srgb, currentColor 9%, var(--cube-ground, var(--bg))); }
  .line { fill: none; stroke: currentColor; stroke-width: 1; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
</style>
