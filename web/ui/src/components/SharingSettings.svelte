<script lang="ts">
  // Settings › general › Sharing (decision D3): what a model upgrade or vault
  // change that grows a shared lens does. The words are Nick's.
  import { lensRequest, type SharingMode } from "../lib/lenses.svelte";
  let mode = $state<SharingMode | null>(null), saving = $state(false), problem = $state("");
  $effect(() => { void lensRequest<{ mode: SharingMode }>("").then((r) => { mode = r.mode; }).catch(() => {}); });
  async function set(next: SharingMode) {
    saving = true; problem = "";
    try { mode = (await lensRequest<{ mode: SharingMode }>("mode", { mode: next })).mode; }
    catch (e) { problem = (e as Error).message; }
    finally { saving = false; }
  }
</script>

<section class="item" aria-label="Sharing">
  <span class="name">Sharing</span>
  <p>Sometimes, a model upgrade or vault change will cause a Lens to include items that weren’t included before. If you’ve shared that Lens to a Server, old items may be suddenly shared. When this happens, <strong>Conservative</strong> mode pauses all new additions to Lens until you review the changes. In <strong>Yee-haw</strong> mode, the lens will keep adding items (but alert you, so you can review the change).</p>
  <div class="choice">
    <span class:chosen={mode === "yeehaw"}>Yee-haw</span>
    <button class="switch" class:on={mode === "conservative"} role="switch" aria-checked={mode === "conservative"} aria-label="Conservative" disabled={mode == null || saving}
      onclick={() => void set(mode === "conservative" ? "yeehaw" : "conservative")}><span class="knob"></span></button>
    <span class:chosen={mode === "conservative"}>Conservative</span>
  </div>
  {#if problem}<small role="alert">{problem}</small>{/if}
</section>

<style>
  .item { display: flex; flex-direction: column; gap: var(--sp-5); }
  .name { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  p { margin: 0; max-width: 620px; font: var(--type-body); line-height: 1.6; color: var(--text-note); }
  strong { font-weight: 600; color: var(--text-strong); }
  .choice { display: flex; align-items: center; gap: var(--sp-3); font: var(--type-body); color: var(--text-muted); }
  .chosen { color: var(--text-strong); }
  .switch { flex: none; position: relative; width: 34px; height: 20px; border: 1px solid var(--rule); border-radius: 999px; background: var(--surface); cursor: pointer; padding: 2px; }
  .switch.on { background: var(--text-strong); border-color: var(--text-strong); }
  .switch:disabled { cursor: default; opacity: .6; }
  .knob { display: block; width: 14px; height: 14px; border-radius: 50%; background: var(--text-muted); transition: transform var(--dur-fast) var(--ease); }
  .switch.on .knob { transform: translateX(14px); background: var(--bg); }
  small { font: var(--type-meta); color: var(--text); }
</style>
