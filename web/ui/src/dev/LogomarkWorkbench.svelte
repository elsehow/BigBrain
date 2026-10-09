<script lang="ts">
  import { untrack } from "svelte";
  import Logomark from "../components/Logomark.svelte";
  import { isSolved, LOOPS, movePose, poseAt, STILL, TURN, type LoopName, type Pose, type Wings } from "../lib/logomark";
  import { PALETTES, THEME_LABEL } from "../lib/theme";

  const { scene = "turning" }: { scene?: string } = $props();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const initial = untrack(() => scene); // the Workbench remounts on each scene change
  let playing = $state(initial === "turning" && !reduced);
  let loopName = $state<LoopName>("flip");
  const loop = $derived(LOOPS[loopName]);
  let turnMs = $state(TURN.turnMs);
  let holdMs = $state(TURN.holdMs);
  let active = $state(true);
  let wings = $state<Wings>("ink");
  // where in the loop, in moves: 1.5 is halfway through move 1. The still
  // mark is a pose of its own, a frame of the column's flip.
  let at = $state(0);
  let still = $state(initial === "still");
  let clock = $state<Pose>(STILL);
  const pose = $derived<Pose>(playing ? clock : still ? STILL : movePose(Math.floor(at), at - Math.floor(at), loop));
  const WINGS: { id: Wings; label: string }[] = [{ id: "ink", label: "ink" }, { id: "paper", label: "paper" }];
  const restLabel = (k: number): string => {
    const m = loop[k]!;
    return `${k} · ${m.slab} ${Math.abs(m.by) === 180 ? "flips" : "steps"}`;
  };

  // ONE clock for every mark on the page, so the themes turn together
  $effect(() => {
    const o = { turnMs, holdMs }, l = loop;
    if (!playing) return;
    const t0 = performance.now();
    let frame = requestAnimationFrame(function step(now: number) {
      clock = poseAt(now - t0, o, l);
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  });
</script>

<section class="lm" aria-label="Logomark workbench">
  <header>
    <div class="lede">
      <h1>The mark, in the theme's three colours</h1>
      <p>Two neutrals shade the cube; the front-left face is the activity colour. The column and the top each carry a third of that face on one side and the side opposite, so a half turn of either lands the face whole. They take turns: the column flips, the top steps a quarter — its front third slips away behind as the opposite one comes onto the right face, then slides into place — and the face is solved at two rests of four. In the flip loop both flip, and every rest is solved; the column loop is the original motion, the column alone, a quarter at a time.</p>
    </div>
    <div class="controls">
      <button class="play" onclick={() => (playing = !playing)}>{playing ? "Pause" : "Play"}</button>
      <output class="angle" aria-live="off">column {pose.column.toFixed(0)}° · top {pose.top.toFixed(0)}°{isSolved(pose) ? " · solved" : ""}</output>
      <div class="group" role="group" aria-label="Loop">
        <span class="lab">loop</span>
        {#each Object.keys(LOOPS) as name (name)}<button aria-pressed={loopName === name} onclick={() => { loopName = name as LoopName; at = 0; }}>{name}</button>{/each}
      </div>
      <label>Position <output>{still ? "still" : at.toFixed(2)}</output><input type="range" min="0" max={loop.length} step="0.01" value={at} oninput={(e) => { at = Number(e.currentTarget.value); still = false; playing = false; }} /></label>
      <div class="group" role="group" aria-label="Rests">
        {#each loop as _, k (k)}<button aria-pressed={!still && !playing && at === k} onclick={() => { at = k; still = false; playing = false; }}>{restLabel(k)}</button>{/each}
        <button aria-pressed={still && !playing} onclick={() => { still = true; playing = false; }}>still · 44°</button>
      </div>
      <label>Quarter turn <output>{turnMs} ms</output><input type="range" min="200" max="2400" step="50" bind:value={turnMs} /></label>
      <label>Hold <output>{holdMs} ms</output><input type="range" min="0" max="4000" step="100" bind:value={holdMs} /></label>
      <div class="group" role="group" aria-label="The gaps the turns open">
        <span class="lab">gap</span>
        {#each WINGS as w (w.id)}<button aria-pressed={wings === w.id} onclick={() => (wings = w.id)}>{w.label}</button>{/each}
        <label class="check"><input type="checkbox" bind:checked={active} /> active face</label>
      </div>
    </div>
  </header>

  <div class="hero">
    <Logomark size={248} {pose} {active} {wings} />
    <div class="lockup"><Logomark size={56} {pose} {active} {wings} label="" /><span>BigBrain</span></div>
    <div class="sizes">
      {#each [112, 72, 48, 32, 24, 16] as s (s)}
        <figure><Logomark size={s} {pose} {active} {wings} label="" /><figcaption>{s}</figcaption></figure>
      {/each}
    </div>
  </div>

  <h2>Every theme</h2>
  <div class="themes">
    {#each PALETTES as id (id)}
      <div class="tile" data-theme={id}>
        <Logomark size={96} {pose} {active} {wings} label="" />
        <div class="foot">
          <span class="name">{THEME_LABEL[id]}</span>
          <span class="swatches" aria-hidden="true"><i class="bg"></i><i class="fg"></i><i class="ac"></i></span>
          <Logomark size={16} {pose} {active} {wings} label="" />
        </div>
      </div>
    {/each}
  </div>
</section>

<style>
  .lm { display: flex; flex-direction: column; gap: 28px; padding-bottom: 40px; }
  header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px 40px; align-items: start; }
  h1 { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); margin: 0 0 10px; }
  .lede p { font: var(--type-body); color: var(--text-note); max-width: 52ch; margin: 0; }
  h2 { font: var(--type-eyebrow); letter-spacing: var(--ls-eyebrow); text-transform: uppercase; color: var(--text-faint); margin: 12px 0 0; }
  .controls { display: grid; grid-template-columns: auto auto; gap: 10px 16px; align-items: center; font: var(--type-meta); color: var(--text-muted); min-width: 340px; max-width: 420px; }
  .controls label { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; grid-column: 1 / -1; }
  .controls label output { text-align: right; font: var(--type-mono); color: var(--text); }
  .controls input[type="range"] { grid-column: 1 / -1; width: 100%; }
  .play { font: var(--type-chip); padding: 6px 14px; border-radius: var(--r-full); border: 1px solid var(--rule); background: var(--surface); color: var(--text-strong); cursor: pointer; }
  .angle { font: var(--type-mono); color: var(--text-faint); justify-self: end; }
  .group { grid-column: 1 / -1; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .group .lab { font: var(--type-meta); color: var(--text-faint); margin-right: 4px; }
  .group button { font: var(--type-meta); padding: 4px 10px; border-radius: var(--r-full); border: 1px solid var(--rule); background: none; color: var(--text-muted); cursor: pointer; }
  .group button[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  .controls label.check { display: flex; gap: 6px; align-items: center; grid-column: auto; margin-left: 8px; }

  .hero { display: flex; align-items: center; gap: 56px; flex-wrap: wrap; }
  .lockup { display: flex; align-items: center; gap: 16px; font: var(--type-title); letter-spacing: var(--ls-title); color: var(--text-strong); }
  .sizes { display: flex; align-items: flex-end; gap: 28px; }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  figcaption { font: var(--type-mono); color: var(--text-faint); }

  .themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 14px; }
  .tile { background: var(--bg); color: var(--fg); border-radius: var(--r-card); padding: 22px 18px 16px; display: flex; flex-direction: column; align-items: center; gap: 18px;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fg) 14%, transparent); }
  .foot { display: flex; align-items: center; gap: 10px; width: 100%; }
  .name { font: var(--type-meta); color: var(--text-muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .swatches { display: flex; gap: 3px; }
  .swatches i { width: 10px; height: 10px; border-radius: 3px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fg) 25%, transparent); }
  .swatches .bg { background: var(--bg); }
  .swatches .fg { background: var(--fg); }
  .swatches .ac { background: var(--activity); }
</style>
