<script lang="ts">
  // Only whether hints show lives here; the shortcuts themselves ship with
  // the components that answer them (lib/shortcuts.svelte.ts), listed on
  // the ? sheet.
  import { keyboardHints, setKeyboardHints } from "../lib/keyboardHints.svelte";
</script>

<section class="item" aria-label="Shortcuts">
    <span class="name">Shortcuts</span>
    <label class="hint-choice">
      <button class="switch" class:on={keyboardHints.show} role="switch" aria-checked={keyboardHints.show}
        aria-label="Show keyboard hints" onclick={() => setKeyboardHints(!keyboardHints.show)}><span class="knob"></span></button>
      <span>Show keyboard hints</span>
    </label>
</section>

<style>
  .item { display: flex; flex-direction: column; gap: var(--sp-5); }
  .name { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  .hint-choice { display: flex; align-items: center; gap: var(--sp-3); font: var(--type-body); color: var(--text); cursor: pointer; }
  .switch { flex: none; position: relative; width: 34px; height: 20px; border: 1px solid var(--rule); border-radius: 999px; background: var(--surface); cursor: pointer; padding: 2px; }
  .switch.on { background: var(--text-strong); border-color: var(--text-strong); }
  .knob { display: block; width: 14px; height: 14px; border-radius: 50%; background: var(--text-muted); transition: transform var(--dur-fast) var(--ease); }
  .switch.on .knob { transform: translateX(14px); background: var(--bg); }
</style>
