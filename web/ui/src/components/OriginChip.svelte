<script lang="ts">
  // The OPEN chip beside DISCUSS returns to the original clipped source.
  // What opens is the source's ORIGIN — the page it was clipped from, the
  // original file a drop carried — as the engine read it off the envelope
  // (lib/sourceOrigin.ts); which opener takes it is ../lib/origin.ts's
  // call. The chip is the same shape as DISCUSS (app.css's .pchip): an
  // eyebrow verb with its key. The caller owns the act — NoteTab answers
  // ⌘O with the same function — and the chip only reports how it went:
  // `failed` is the engine's refusal, shown in the chip's own words for a
  // few seconds and then back to OPEN.
  import { originHint } from "../lib/origin";
  import type { SourceOrigin } from "../lib/types";
  import { tooltip } from "../lib/tooltip";

  const { origin, failed, onclick }: { origin: SourceOrigin; failed: boolean; onclick: (e: MouseEvent) => void } =
    $props();
</script>

<button class="pchip" data-talks-when-empty class:failed use:tooltip={failed ? "The engine could not open it — see its log" : originHint(origin)} {onclick}>
  {failed ? "Couldn’t open" : "Open"}{#if !failed}<span class="kbd">⌘O</span>{/if}
</button>

<style>
  /* .pchip itself is shared in app.css. */
  .pchip.failed { color: var(--text-strong); }
</style>
