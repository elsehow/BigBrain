<script lang="ts">
  import { onDestroy } from 'svelte';
  import { EFFECT_PRESETS, effectPreset } from '../lib/graph/effects';
  let running = $state(false), result = $state('');
  let frame = 0, disposed = false;
  const params = new URLSearchParams(location.search);
  const effects = effectPreset(params.get('graphEffects') ?? 'all'), theme = document.documentElement.dataset.theme ?? 'default';
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  function choose(event: Event, key = 'graphEffects') {
    const url = new URL(location.href); url.searchParams.set(key, (event.target as HTMLSelectElement).value);
    location.href = url.href;
  }
  async function run() {
    if (running) return;
    (document.activeElement as HTMLElement | null)?.blur();
    running = true; result = '';
    const width = innerWidth, height = innerHeight, intervals: number[] = [], selections = new Set<string>();
    let previous = 0, changedSize = false;
    const tick = (time: number) => {
      if (previous) intervals.push(time - previous);
      previous = time; changedSize ||= innerWidth !== width || innerHeight !== height;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    try {
      for (const key of [...Array<string>(12).fill('j'), ...Array<string>(12).fill('k')]) {
        if (disposed) return;
        window.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key, code: `Key${key.toUpperCase()}`, bubbles: true }));
        await pause(180);
        selections.add(document.querySelector('.workspace-menu [aria-current="true"] .title')?.textContent ?? '');
      }
      const sorted = intervals.slice().sort((a, b) => a - b);
      result = changedSize ? 'Window resized — discard this run.' : selections.size < 2 ? 'Selection did not change — discard this run.' : JSON.stringify({
        renderer: 'webgl', effects, theme, viewport: [width, height], dpr: devicePixelRatio,
        medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor((sorted.length - 1) * .95)],
        over25ms: intervals.filter(n => n > 25).length, samples: intervals.length,
        source: document.querySelector('#preview-provenance')?.textContent,
      }, null, 2);
    } finally { cancelAnimationFrame(frame); running = false; }
  }
  onDestroy(() => { disposed = true; cancelAnimationFrame(frame); });
</script>
<aside aria-label="Navigation profiling" class="graph-profile-controls">
  <button onclick={() => void run()} disabled={running}>{running ? 'Walking…' : 'Run j/k profile'}</button>
    <label>Effects <select value={effects} onchange={event => choose(event, 'graphEffects')} disabled={running}>{#each EFFECT_PRESETS as value}<option {value}>{value}</option>{/each}</select></label>
    <label>Theme <select value={theme} onchange={event => choose(event, 'graphTheme')} disabled={running}>{#each ['default', 'dusk', 'phosphor'] as value}<option {value}>{value}</option>{/each}</select></label>
    <label>Working agent demo <input type="checkbox" checked={params.get('graphWorking') === '1'} disabled={running} onchange={event => { const url = new URL(location.href); url.searchParams.set('graphWorking', event.currentTarget.checked ? '1' : '0'); location.href = url.href; }} /></label>
    <small>Glow appears on dark themes. Trails appear during motion. Breathing marks working agents.</small>
  <small>Keep the window size fixed. Snapshot graph; sample note content.</small>
  {#if result}<textarea aria-label="Profiling result" readonly value={result} rows="9"></textarea>{/if}
</aside>
<style>
  aside { position:fixed; bottom:32px; right:20px; z-index:10000; width:310px; padding:12px; background:var(--bg); color:var(--text); border:1px solid var(--rule); display:grid; gap:8px; font:12px system-ui; }
  label { display:flex; justify-content:space-between; gap:8px; }
  textarea { width:100%; box-sizing:border-box; font:11px monospace; }
</style>
