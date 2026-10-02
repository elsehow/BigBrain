<script lang="ts">
  import NodeIndicator from "./NodeIndicator.svelte";
  import { mentionText, parseMentions } from "../../../../lib/pilotMentions";
  import type { NotificationItem } from "../lib/notificationTypes";
  import type { PilotVisualPhase } from "../lib/pilotAppearance";
  let { item, phase = "idle", onopen, ondismiss }: {
    item: NotificationItem; phase?: PilotVisualPhase;
    onopen: (item: NotificationItem) => void; ondismiss: (id: string) => void;
  } = $props();
</script>

<article class:unseen={!item.seen}>
  <button class="notice-open" onclick={() => { onopen(item); }}>
    <span role="img" aria-label={`Pilot ${phase}`} title={`Pilot ${phase}`}><NodeIndicator size={25} state={phase} /></span>
    <span class="notice-copy"><span class="notice-meta"><span>{item.pilotTitle}</span><time>{item.at}</time></span><span class="notice-text">{mentionText(parseMentions(item.text))}</span><span class="notice-kind">{#if !item.seen}<i aria-label="New notification"></i>{/if}{item.kind === "question" ? "Needs you" : "Update"}{#if item.seen} <span class="seen">· Seen</span>{/if}</span></span>
  </button>
  <div class="notice-actions">
    <button class="small-button" onclick={() => ondismiss(item.id)} aria-label={`Dismiss ${item.pilotTitle}`} title="Dismiss">×</button>
  </div>
</article>

<style>
  article { position: relative; border-radius: 8px; color: var(--text-strong); }
  article:hover, article:focus-within { background: var(--text-strong); color: var(--bg); --glyph-bg: var(--text-strong); }
  .notice-open { display: flex; gap: 10px; align-items: flex-start; padding: 13px 12px; width: 100%; background: none; color: inherit; border: 0; border-radius: 8px; text-align: left; cursor: pointer; }
  .notice-open:focus-visible { outline: 2px solid var(--dash); outline-offset: -2px; }
  .notice-copy { flex: 1; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; }
  .notice-meta { display: flex; min-width: 0; justify-content: space-between; gap: 12px; color: var(--text-muted); font: 500 10px/1.5 var(--font-mono); }
  .notice-meta > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } time { flex: none; }
  .notice-text { font: 500 14px/1.45 var(--font-app); overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden; }
  .unseen .notice-text { font-weight: 650; }
  .notice-kind { display: flex; align-items: center; gap: 6px; color: var(--text-muted); font: 500 10px/1.5 var(--font-mono); min-height: 20px; padding-right: 60px; }
  .notice-kind i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  article:hover :is(.notice-meta, .notice-kind), article:focus-within :is(.notice-meta, .notice-kind) { color: inherit; opacity: .75; }
  .notice-actions { position: absolute; bottom: 8px; right: 8px; display: flex; gap: 2px; }
  .small-button { width: 26px; height: 26px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; color: inherit; background: transparent; font: 20px/1 var(--font-app); cursor: pointer; opacity: .6; }
  .small-button:hover, .small-button:focus-visible { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); }

</style>
