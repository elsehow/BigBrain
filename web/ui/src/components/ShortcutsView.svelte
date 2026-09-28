<script lang="ts">
  import KeyboardModifier from "./KeyboardModifier.svelte";
  import { keyboardHints, setKeyboardHints } from "../lib/keyboardHints.svelte";
</script>

<section class="item" aria-label="Shortcuts">
    <span class="name">Shortcuts</span>
    <label class="hint-choice">
      <button class="switch" class:on={keyboardHints.show} role="switch" aria-checked={keyboardHints.show}
        aria-label="Show keyboard hints" onclick={() => setKeyboardHints(!keyboardHints.show)}><span class="knob"></span></button>
      <span>Show keyboard hints</span>
    </label>
    <dl class="fixed-bindings" aria-label="In-app shortcuts">
      <div><dt>Focus notifications</dt><dd><kbd>n</kbd></dd></div>
      <div><dt>Navigate notifications</dt><dd><kbd>↑</kbd> / <kbd>↓</kbd> or <kbd>k</kbd> / <kbd>j</kbd></dd></div>
      <div><dt>Edit notification note</dt><dd><kbd>i</kbd></dd></div>
      <div><dt>Open selected agent conversation</dt><dd><kbd>o</kbd></dd></div>
      <div><dt>Clear selected notification</dt><dd><kbd>c</kbd></dd></div>
      <div><dt>Leave notifications</dt><dd><kbd>Esc</kbd></dd></div>
      <div><dt>Open Pilots</dt><dd><kbd>a</kbd></dd></div>
      <div><dt>Navigate Pilots</dt><dd><kbd>↑</kbd> / <kbd>↓</kbd> or <kbd>k</kbd> / <kbd>j</kbd></dd></div>
      <div><dt>Open selected Pilot</dt><dd><kbd>Enter</kbd></dd></div>
      <div><dt>Archive selected agent</dt><dd><kbd><KeyboardModifier name="shift" />Esc</kbd></dd></div>
      <div><dt>Close Pilots</dt><dd><kbd>Esc</kbd></dd></div>
      <div><dt>Select all unread sources</dt><dd><kbd>u</kbd></dd></div>
      <div><dt>Toggle source read status</dt><dd><kbd><KeyboardModifier name="shift" />U</kbd></dd></div>
    </dl>
</section>

<style>
  .fixed-bindings { display: grid; gap: var(--sp-4); margin: 0; font: var(--type-body); color: var(--text-note); }
  .fixed-bindings div { display: flex; justify-content: space-between; gap: var(--sp-5); }
  .fixed-bindings dd { margin: 0; flex: none; }
  .fixed-bindings kbd { font: var(--type-chip); color: var(--text-strong); }
  .item { display: flex; flex-direction: column; gap: var(--sp-5); }
  .name { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  .hint-choice { display: flex; align-items: center; gap: var(--sp-3); font: var(--type-body); color: var(--text); cursor: pointer; }
  .switch { flex: none; position: relative; width: 34px; height: 20px; border: 1px solid var(--rule); border-radius: 999px; background: var(--surface); cursor: pointer; padding: 2px; }
  .switch.on { background: var(--text-strong); border-color: var(--text-strong); }
  .knob { display: block; width: 14px; height: 14px; border-radius: 50%; background: var(--text-muted); transition: transform var(--dur-fast) var(--ease); }
  .switch.on .knob { transform: translateX(14px); background: var(--bg); }

</style>
