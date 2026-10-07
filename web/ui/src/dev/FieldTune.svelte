<script lang="ts">
  // Dev only: sliders over the Field's look (lib/v2/look.ts), for trying how
  // sources might read apart from entities. Mounted beside the app by
  // fieldTune.ts when the dev server runs with BIGBRAIN_FIELD_TUNE=1.
  import { look, LOOK_DEFAULTS, type FieldLook } from "../lib/v2/look";
  import { graphSources, setGraphSources } from "../lib/graphSources.svelte";

  type Knob = { key: keyof FieldLook; label: string; min: number; max: number; step: number };
  const SOURCES: Knob[] = [
    { key: "srcSize", label: "Size", min: 0.2, max: 4, step: 0.05 },
    { key: "srcByTies", label: "Size by mentions", min: 0, max: 1, step: 0.05 },
    { key: "srcAlpha", label: "Opacity", min: 0, max: 1, step: 0.01 },
    { key: "srcTone", label: "Ink (dust → full)", min: 0, max: 1, step: 0.01 },
    { key: "srcAccent", label: "Accent", min: 0, max: 1, step: 0.01 },
    { key: "srcHole", label: "Hollow (ring)", min: 0, max: 1, step: 0.01 },
    { key: "srcSquare", label: "Square", min: 0, max: 1, step: 0.01 },
    { key: "srcTurn", label: "Turn 45°", min: 0, max: 1, step: 0.01 },
    { key: "srcLift", label: "Height", min: -5, max: 5, step: 0.1 },
    { key: "srcFlat", label: "Flatten to a plane", min: 0, max: 1, step: 0.01 },
    { key: "srcTies", label: "Ties at rest", min: 0, max: 0.5, step: 0.005 },
  ];
  const ENTITIES: Knob[] = [
    { key: "entSize", label: "Size", min: 0.2, max: 3, step: 0.05 },
    { key: "entByTies", label: "Size by mentions", min: 0, max: 1, step: 0.05 },
    { key: "entAlpha", label: "Opacity", min: 0, max: 1.6, step: 0.01 },
    { key: "entTone", label: "Ink (dust → full)", min: 0, max: 1, step: 0.01 },
  ];
  const KEY = "bigbrain.field-tune";

  let v = $state<FieldLook>({ ...LOOK_DEFAULTS });
  try { Object.assign(v, JSON.parse(localStorage.getItem(KEY) ?? "{}")); } catch { /* the defaults */ }
  let open = $state(true), copied = $state(false);
  $effect(() => {
    Object.assign(look, $state.snapshot(v));
    try { localStorage.setItem(KEY, JSON.stringify($state.snapshot(v))); } catch { /* this window only */ }
  });
  const changed = $derived((Object.keys(LOOK_DEFAULTS) as Array<keyof FieldLook>).filter((k) => v[k] !== LOOK_DEFAULTS[k]));
  const reset = () => Object.assign(v, LOOK_DEFAULTS);
  async function copy(): Promise<void> {
    const out = Object.fromEntries(changed.map((k) => [k, v[k]]));
    await navigator.clipboard.writeText(JSON.stringify({ showSources: graphSources.show, ...out }, null, 2));
    copied = true;
    setTimeout(() => (copied = false), 1400);
  }
  const fmt = (x: number) => (Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(2));
</script>

<aside class="tune" class:shut={!open} aria-label="Field look">
  <header>
    <button type="button" class="title" onclick={() => (open = !open)} aria-expanded={open}>Field look{changed.length ? ` · ${changed.length} changed` : ""}</button>
    {#if open}
      <button type="button" onclick={copy} disabled={!changed.length}>{copied ? "Copied" : "Copy"}</button>
      <button type="button" onclick={reset} disabled={!changed.length}>Reset</button>
    {/if}
  </header>
  {#if open}
    <label class="switch"><input type="checkbox" checked={graphSources.show} onchange={(e) => setGraphSources(e.currentTarget.checked)} /> Show sources</label>
    {#each [["Sources", SOURCES], ["Entities", ENTITIES]] as const as [title, knobs] (title)}
      <h3>{title}</h3>
      {#each knobs as k (k.key)}
        <label class="row" class:moved={v[k.key] !== LOOK_DEFAULTS[k.key]}>
          <span>{k.label}</span>
          <input type="range" min={k.min} max={k.max} step={k.step} bind:value={v[k.key]} ondblclick={() => (v[k.key] = LOOK_DEFAULTS[k.key])} />
          <output>{fmt(v[k.key])}</output>
        </label>
      {/each}
    {/each}
    <p>Double-click a slider to reset it.</p>
  {/if}
</aside>

<style>
  .tune { position: fixed; z-index: 40; right: 16px; bottom: 16px; width: 300px; max-height: calc(100vh - 32px); overflow: auto;
    padding: 10px 14px 12px; background: var(--bg); border: 1px solid var(--rule); border-radius: var(--r-sm, 6px);
    font: 400 12.5px/1.35 var(--font-app); color: var(--text); box-shadow: 0 10px 40px -24px color-mix(in srgb, var(--fg) 50%, transparent); }
  .tune.shut { width: auto; padding-bottom: 10px; }
  header { display: flex; align-items: center; gap: 6px; }
  header button { font: inherit; padding: 2px 8px; border: 1px solid var(--rule); border-radius: var(--r-sm, 6px); background: none; color: var(--text); cursor: pointer; }
  header button:disabled { color: var(--text-faint); cursor: default; }
  header .title { margin-right: auto; padding: 2px 0; border: 0; font-weight: 550; }
  h3 { margin: 12px 0 4px; font: 550 11px/1 var(--font-app); letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-muted); }
  .switch { display: flex; align-items: center; gap: 8px; margin-top: 10px; cursor: pointer; }
  .switch input { margin: 0; accent-color: var(--text-strong); }
  .row { display: grid; grid-template-columns: 108px 1fr 36px; align-items: center; gap: 8px; padding: 2px 0; color: var(--text-muted); }
  .row.moved { color: var(--text); }
  .row input { width: 100%; margin: 0; accent-color: var(--text-strong); }
  output { text-align: right; font-variant-numeric: tabular-nums; }
  p { margin: 10px 0 0; color: var(--text-faint); font-size: 11.5px; }
</style>
