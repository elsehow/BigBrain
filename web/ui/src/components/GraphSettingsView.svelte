<script lang="ts">
  // What the field draws at rest. A viewer preference (localStorage), like
  // the keyboard hints below it; the scene reads it (lib/v2/scene.ts).
  import { graphSources, setGraphSources } from "../lib/graphSources.svelte";
</script>

<section class="item" aria-label="Graph">
    <span class="name">Graph</span>
    <label class="choice">
      <button class="switch" class:on={graphSources.show} role="switch" aria-checked={graphSources.show}
        aria-label="Show sources" onclick={() => setGraphSources(!graphSources.show)}><span class="knob"></span></button>
      <span>Show sources</span>
    </label>
</section>

<style>
  .item { display: flex; flex-direction: column; gap: var(--sp-5); }
  .name { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  .choice { display: flex; align-items: center; gap: var(--sp-3); font: var(--type-body); color: var(--text); cursor: pointer; }
  .switch { flex: none; position: relative; width: 34px; height: 20px; border: 1px solid var(--rule); border-radius: 999px; background: var(--surface); cursor: pointer; padding: 2px; }
  .switch.on { background: var(--text-strong); border-color: var(--text-strong); }
  .knob { display: block; width: 14px; height: 14px; border-radius: 50%; background: var(--text-muted); transition: transform var(--dur-fast) var(--ease); }
  .switch.on .knob { transform: translateX(14px); background: var(--bg); }
</style>
