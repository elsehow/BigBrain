<script lang="ts">
  import { stepped, createListJump } from "../lib/listNav";
  import NotificationCard from "./NotificationCard.svelte";
  import { editable } from "../lib/dom";
  import { tick } from "svelte";
  import NodeIndicator from "./NodeIndicator.svelte";
  import type { NotificationItem } from "../lib/notificationTypes";
  import type { PilotVisualPhase } from "../lib/pilotAppearance";
  let { items, pilotStates, open = $bindable(false), onopen, ondismiss, onseen }: {
    pilotStates: Record<string, PilotVisualPhase>;
    items: NotificationItem[]; open?: boolean;
    onopen: (item: NotificationItem) => void;
    ondismiss: (id: string) => void;
    onseen: () => void;
  } = $props();
  let anchor: HTMLDivElement, trigger: HTMLButtonElement;
  let panel = $state<HTMLElement>();
  let panelShift = $state(0);
  function fitPanel(): void {
    if (!panel) return;
    const r = panel.getBoundingClientRect(), left = r.left - panelShift;
    panelShift = Math.max(16 - left, Math.min(0, window.innerWidth - 16 - (left + r.width)));
  }
  $effect(() => { if (open) void tick().then(() => { fitPanel(); (panel?.querySelector<HTMLButtonElement>(".notice-open") ?? panel)?.focus(); }); });
  const visible = $derived(items.filter(n => !n.resolved && !n.dismissed));
  const unseen = $derived(visible.filter(n => !n.seen).length);
  const waiting = $derived(new Set(visible.filter(n => n.kind === "question").map(n => n.pilotId)).size);
  function toggle() { open = !open; }
  function close() { open = false; trigger?.focus(); }
  function outside(e: PointerEvent) { if (open && e.target instanceof Node && !anchor?.contains(e.target)) open = false; }
  const listJump = createListJump();
  function keyboard(e: KeyboardEvent) {
    if (!open || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    if (e.key === "c") {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) for (const item of visible) ondismiss(item.id);
      panel?.focus(); return;
    }
    const jump = listJump(e);
    if (jump) { e.preventDefault(); e.stopImmediatePropagation(); const rows = [...panel?.querySelectorAll<HTMLButtonElement>(".notice-open") ?? []]; if (jump !== 'pending') rows[jump === 'first' ? 0 : rows.length - 1]?.focus(); return; }
    if (["ArrowDown", "ArrowUp", "j", "k"].includes(e.key)) {
      const rows = [...panel?.querySelectorAll<HTMLButtonElement>(".notice-open") ?? []];
      if (!rows.length) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const i = rows.indexOf(document.activeElement as HTMLButtonElement);
      const down = e.key === "ArrowDown" || e.key === "j";
      rows[i < 0 ? (down ? 0 : rows.length - 1) : stepped(i, down ? 1 : -1, rows.length)]?.focus();
    }
  }
</script>

<svelte:window onpointerdown={outside} onkeydowncapture={keyboard} onresize={fitPanel} />
<div class="notification-anchor" bind:this={anchor}>
  <button class="chrome-button" class:pressed={open} bind:this={trigger} onclick={toggle}
    aria-label={`Notifications${unseen ? `, ${unseen} new` : ""}`} title="Notifications"
    aria-expanded={open} aria-controls={open ? "notification-center" : undefined} aria-haspopup="dialog">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
    </svg>
    {#if unseen}<span class="badge" aria-hidden="true">{unseen > 99 ? "99+" : unseen}</span>{/if}
  </button>
  {#if open}
    <div id="notification-center" class="notification-panel" style:translate={`${panelShift}px 0`} role="dialog" aria-label="Notifications" tabindex="-1" bind:this={panel}>
      <header><div><strong>Notifications</strong><span>{waiting ? `${waiting} ${waiting === 1 ? "Pilot needs" : "Pilots need"} you` : "From your Pilots"}</span></div><button class="small-button" aria-label="Close notifications" onclick={close}>×</button></header>
      <div class="notification-scroll">
        {#each visible as item (item.id)}
          <NotificationCard {item} phase={pilotStates[item.pilotId]} onopen={(n) => { onopen(n); open = false; }} {ondismiss} />
        {:else}
          <div class="empty"><NodeIndicator size={30} state="idle" /><strong>You’re caught up</strong><p>When a Pilot needs you or has an update to share, it will appear here.</p></div>
        {/each}
      </div>
      <footer><button onclick={onseen} disabled={!unseen}>Mark all seen</button></footer>
    </div>
  {/if}
</div>

<style>
  .notification-anchor { position: relative; flex: none; }
  .chrome-button { width: var(--size-icon-btn); height: var(--size-icon-btn); border-radius: var(--r-full); background: var(--surface); color: var(--icon); border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; position: relative; }
  .chrome-button:hover, .chrome-button.pressed { box-shadow: inset 0 0 0 1px var(--dash); }
  .badge { position: absolute; right: -2px; top: -3px; min-width: 16px; height: 16px; padding: 0 3px; box-sizing: border-box; border-radius: 12px; background: var(--text-strong); color: var(--bg); font: 600 10px/16px var(--font-mono); text-align: center; border: 2px solid var(--bg); line-height: 12px; }
  .notification-panel { position: absolute; top: calc(100% + 14px); right: calc(0px - var(--size-icon-btn) - var(--sp-4)); width: min(430px, calc(100cqw - 32px)); box-sizing: border-box; z-index: 12; overflow: hidden; padding: 8px; border: 1px solid var(--rule); border-radius: 14px; background: var(--bg); box-shadow: 0 8px 24px color-mix(in srgb, var(--text-strong) 7%, transparent); animation: arrive 160ms cubic-bezier(.2,.8,.2,1) both; outline: none; }
  header { display: flex; align-items: flex-start; justify-content: space-between; padding: 12px 12px 16px; }
  header div { display: grid; gap: 4px; } header strong { font: 650 16px/1.4 var(--font-app); } header span { font: var(--type-meta); color: var(--text-muted); }
  .notification-scroll :global(article + article) { margin-top: 3px; }
  .notification-scroll { max-height: min(460px, 60dvh); overflow-y: auto; overscroll-behavior: contain; }
  .small-button { width: 26px; height: 26px; border: 0; background: transparent; color: inherit; font: 20px/1 var(--font-app); cursor: pointer; }
  footer { margin-top: 8px; border-top: 1px solid var(--rule); padding: 12px 12px 4px; display: flex; justify-content: flex-end; }
  footer button { background: none; color: var(--text-muted); font: var(--type-meta); border: 0; padding: 0; cursor: pointer; } footer button:disabled { opacity: .4; cursor: default; }
  .empty { display: grid; justify-items: center; padding: 38px 28px 44px; gap: 15px; text-align: center; } .empty strong { font: 600 15px/1.5 var(--font-app); } .empty p { margin: 0; max-width: 270px; font: var(--type-body); color: var(--text-muted); }
  @keyframes arrive { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) { .notification-panel { animation: none; } }
  @container (max-width: 580px) { .notification-panel { right: calc(0px - var(--size-icon-btn) - 8px); } }
</style>
