<script lang="ts">
  // The mark, drawn from lib/logomark.ts at one pose, in the theme's
  // three colours. Still, it holds `pose` — the brand's 44° unless told
  // otherwise. `turning` plays `loop` from solved — unless the person
  // asked for reduced motion, in which case the still pose is all they get.
  import { untrack } from "svelte";
  import { faces, FLIP, poseAt, STILL, TURN, VIEWBOX, type Move, type Pose, type Wings } from "../lib/logomark";

  let {
    size = 36,
    pose = STILL,
    turning = false,
    loop = FLIP,
    active = true,
    wings = "ink",
    label = "BigBrain",
    turnMs = TURN.turnMs,
    holdMs = TURN.holdMs,
  }: {
    size?: number;
    pose?: Pose;
    turning?: boolean;
    loop?: readonly Move[];
    /** the front-left face in the activity colour; off is all monochrome */
    active?: boolean;
    wings?: Wings;
    /** "" makes it decorative */
    label?: string;
    turnMs?: number;
    holdMs?: number;
  } = $props();

  // the initial value on purpose: the effect below keeps it current
  let clock = $state<Pose>(untrack(() => pose));
  $effect(() => {
    if (!turning || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      clock = pose;
      return;
    }
    const o = { turnMs, holdMs }, l = loop;
    const t0 = performance.now();
    let frame = requestAnimationFrame(function step(now: number) {
      clock = poseAt(now - t0, o, l);
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  });
  const shown = $derived(faces(clock, { active, wings }));
</script>

<!-- A hairline stroke in each face's own colour closes the anti-aliasing
     seam between faces that share an edge; whatever is painted later owns
     the edge, so a stroke never reaches past a silhouette. -->
<svg width={size} height={size} viewBox={VIEWBOX} role={label ? "img" : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : "true"}>
  {#each shown as f, i (i)}
    <path d={f.d} fill={f.fill} stroke={f.fill} stroke-width="0.3" />
  {/each}
</svg>

<style>
  svg { display: block; flex: none; }
</style>
