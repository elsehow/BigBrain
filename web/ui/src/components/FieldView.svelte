<script lang="ts">
  // Field: the v2 view on the base. Settings open as a panel over the field
  // (by the hash, so ⌘, and links land the same way); the field keeps
  // running beneath, and gets its keys back when the panel closes.
  import DropZone from "./DropZone.svelte";
  import NotificationStack from "./NotificationStack.svelte";
  import SettingsScreens from "./SettingsScreens.svelte";
  import V2View from "./V2View.svelte";
  import { app, goto } from "../lib/store.svelte";
  import { isSettingsView } from "../lib/settingsViews";

  const open = $derived(isSettingsView(app.view));
  const close = () => goto("home");
  function onKey(e: KeyboardEvent): void {
    if (open && e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); close(); }
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<DropZone />
<V2View paused={open} />
{#if open}
  <div class="scrim" role="presentation" onclick={close}></div>
  <aside class="panel" aria-label="Settings">
    <button type="button" class="close" onclick={close} aria-label="Close settings" title="Close (Esc)">
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
    </button>
    <SettingsScreens />
  </aside>
{/if}
<NotificationStack />

<style>
  .scrim { position: fixed; inset: 0; z-index: 20; background: color-mix(in srgb, var(--bg) 35%, transparent); }
  .panel { position: fixed; z-index: 21; top: 0; right: 0; bottom: 0; width: min(1040px, 100%); display: flex; flex-direction: column;
    background: var(--bg); box-shadow: -1px 0 0 var(--rule), -28px 0 70px -40px color-mix(in srgb, var(--fg) 45%, transparent);
    animation: slide .18s ease-out; }
  .close { position: absolute; top: 18px; right: 18px; z-index: 1; display: inline-flex; padding: 6px; border: 0; border-radius: 999px;
    background: none; color: var(--text-muted); cursor: pointer; }
  .close:hover { color: var(--text); background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  @keyframes slide { from { transform: translateX(24px); opacity: 0; } }
</style>
