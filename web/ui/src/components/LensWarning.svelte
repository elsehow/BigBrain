<script lang="ts">
  // A lens a change grew while shared (D3), until it is reviewed: on the lens
  // itself and in Settings › lenses, so it is seen even when the feed is not.
  import { reviewWords, type LensReviewSummary, type ServerRef } from "../lib/lenses.svelte";
  let { review, servers, busy = false, onchanges, onedit, onok }: {
    review: Pick<LensReviewSummary, "reason" | "hold">; servers: ServerRef[]; busy?: boolean;
    onchanges: () => void; onedit: () => void; onok: () => void;
  } = $props();
</script>

<section class="warning" aria-label="Review">
  <p>{reviewWords(review, servers)}</p>
  <div class="actions">
    <button class="text-button" onclick={onchanges}>What changed</button>
    <button class="text-button" disabled={busy} onclick={onedit}>Edit rule</button>
    <button class="primary" disabled={busy} onclick={onok}>Looks OK</button>
  </div>
</section>

<style>
  .warning { display: grid; gap: 14px; padding: 18px 20px; border: 1px solid var(--text-strong); }
  p { margin: 0; font: var(--type-body); line-height: 1.6; color: var(--text-strong); }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 12px 24px; }
  .text-button { border: 0; background: none; padding: 0; font: var(--type-meta); color: var(--text); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
  .text-button:disabled { opacity: .45; cursor: default; }
  .primary { font: var(--type-body); padding: 10px 18px; border: 1px solid var(--text-strong); background: var(--text-strong); color: var(--bg); cursor: pointer; }
  .primary:disabled { opacity: .35; cursor: default; }
</style>
