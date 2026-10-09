<script lang="ts">
  // Field: the v2 view on the base. Settings open as a panel over the field
  // (by the hash, so ⌘, and links land the same way); the field keeps
  // running beneath, and gets its keys back when the panel closes.
  import DropZone from "./DropZone.svelte";
  import Feedback from "./Feedback.svelte";
  import TopStrips from "./TopStrips.svelte";
  import NotificationStack from "./NotificationStack.svelte";
  import ExpiredClientNotices from "./ExpiredClientNotices.svelte";
  import IntegrationReconnectNotices from "./IntegrationReconnectNotices.svelte";
  import SettingsScreens from "./SettingsScreens.svelte";
  import V2View from "./V2View.svelte";
  import { app, goto } from "../lib/store.svelte";
  import { isSettingsView } from "../lib/settingsViews";
  import { keyboardHints } from "../lib/keyboardHints.svelte";
  import { keyText, registerShortcuts, RANK } from "../lib/shortcuts.svelte";

  const open = $derived(isSettingsView(app.view));
  // the hints toggle reaches every .keyboard-hint chip through app.css
  $effect(() => { document.documentElement.dataset.keyboardHints = keyboardHints.show ? "on" : "off"; });
  // the Feedback button shows while the pointer moves, as in Classic
  let awake = $state(false), feedbackOpen = $state(false);
  let sleep: ReturnType<typeof setTimeout> | undefined;
  const wake = () => { awake = true; clearTimeout(sleep); sleep = setTimeout(() => { awake = false; }, 2500); };
  const close = () => goto("home");
  // Esc closes the panel, from any field in it. An open Feedback dialog is
  // modal, so the registry hands its keys to the dialog instead.
  $effect(() => {
    if (open) return registerShortcuts({ title: "Settings", rank: RANK.panel, shortcuts: [
      { id: "settings-close", label: "Close settings", keys: [{ key: "Escape", typing: true }], run: close },
    ] });
  });
</script>

<svelte:window onpointermove={wake} />

<!-- The strips (TopStrips: an update, a provider out of credits) take the
     window's top edge, and the field, Settings and the notices are laid out
     in the room below them (#171: drawn over the field, the strips covered
     its top bar, a chat's top row and Settings' close button). -->
<div class="frame">
  <TopStrips />
  <div class="below">
    <V2View paused={open || feedbackOpen} />
    {#if open}
      <div class="scrim" role="presentation" onclick={close}></div>
      <aside class="panel" aria-label="Settings">
        <button type="button" class="close" onclick={close} aria-label="Close settings" title={`Close ${keyText("settings-close") && `(${keyText("settings-close")})`}`}>
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
        <SettingsScreens />
      </aside>
    {/if}
    <NotificationStack />
  </div>
  <DropZone />
  <ExpiredClientNotices />
  <IntegrationReconnectNotices />
  <div class="feedback"><Feedback bind:open={feedbackOpen} visible={awake} panel={open ? "settings" : "field"} expanded={false} {wake} /></div>
</div>

<style>
  .frame { position: fixed; inset: 0; display: flex; flex-direction: column; }
  .below { position: relative; flex: 1; min-height: 0; }
  .scrim { position: absolute; inset: 0; z-index: 20; background: color-mix(in srgb, var(--bg) 35%, transparent); }
  /* the notices keep their corner (NotificationStack): the panel widens
     into their column and lays Settings out beside it, or, in a narrower
     window, starts Settings below them */
  .panel { position: absolute; z-index: 21; top: 0; right: 0; bottom: 0; width: min(calc(1040px + var(--notice-lane, 0px)), 100%); display: flex; flex-direction: column;
    box-sizing: border-box; padding: var(--notice-band, 0px) var(--notice-lane, 0px) 0 0; background: var(--bg); box-shadow: -1px 0 0 var(--rule), -28px 0 70px -40px color-mix(in srgb, var(--fg) 45%, transparent);
    animation: slide .18s ease-out; }
  .close { position: absolute; top: 18px; right: 18px; z-index: 1; display: inline-flex; padding: 6px; border: 0; border-radius: 999px;
    background: none; color: var(--text-muted); cursor: pointer; }
  .close:hover { color: var(--text); background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  /* above the field's key hints, which hold the bottom-right corner */
  .feedback :global(.feedback-trigger) { bottom: 52px; }
  @keyframes slide { from { transform: translateX(24px); opacity: 0; } }
</style>
