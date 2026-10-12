<script lang="ts">
  // Anything that changes who can read a lens is confirmed by typing its name.
  import type { Snippet } from "svelte";
  let { title, name, action, busy = false, error = "", onconfirm, oncancel, children }: {
    title?: string; name: string; action: string; busy?: boolean; error?: string;
    onconfirm: (typed: string) => void; oncancel: () => void; children: Snippet;
  } = $props();
  let typed = $state("");
  const ready = $derived(typed.trim() === name.trim() && !busy);
  function open(dialog: HTMLDialogElement) { dialog.showModal(); }
</script>

<dialog use:open onclose={oncancel} aria-label={title ?? action}>
  <form onsubmit={(e) => { e.preventDefault(); if (ready) onconfirm(typed); }}>
    {#if title}<h2>{title}</h2>{/if}
    <p>{@render children()}</p>
    <label>{#if title}<span>Type <strong>{name}</strong> to confirm</span>{/if}
      <input aria-label="Lens name" placeholder={name} bind:value={typed} autocomplete="off" spellcheck="false" />
    </label>
    {#if error}<small role="alert">{error}</small>{/if}
    <div class="actions">
      <button type="button" onclick={(e) => e.currentTarget.closest("dialog")?.close()}>Cancel</button>
      <button class="primary" disabled={!ready}>{action}</button>
    </div>
  </form>
</dialog>

<style>
  dialog { width: min(520px, calc(100vw - 32px)); box-sizing: border-box; padding: 32px; border: 1px solid var(--rule); background: var(--bg); color: var(--text); }
  dialog::backdrop { background: #0005; }
  form { display: grid; gap: 22px; }
  h2 { margin: 0; font: var(--type-heading); color: var(--text-strong); }
  p { margin: 0; font: var(--type-body); line-height: 1.6; }
  p :global(strong), label strong { color: var(--text-strong); font-weight: 600; }
  label { display: grid; gap: 8px; font: var(--type-meta); color: var(--text-muted); }
  input { appearance: none; box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--rule); border-radius: 0; padding: 12px 14px; background: var(--well); color: var(--text-strong); font: var(--type-body); }
  input::placeholder { color: var(--text-muted); opacity: .55; }
  input:focus-visible { outline: 1px solid var(--text-muted); outline-offset: 3px; }
  small { font: var(--type-meta); color: var(--accent, var(--text)); }
  .actions { display: flex; justify-content: flex-end; gap: 12px; }
  button { font: var(--type-body); padding: 10px 18px; border: 1px solid var(--rule); background: none; color: var(--text); cursor: pointer; }
  button.primary { background: var(--text-strong); border-color: var(--text-strong); color: var(--bg); }
  button:disabled { opacity: .35; cursor: default; }
</style>
