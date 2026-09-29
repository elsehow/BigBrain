<script lang="ts">
  import "../lib/settingsLists.css";
  import SettingsRail from "./SettingsRail.svelte";
  import type { SettingsTab } from "../lib/settingsViews";
  import type { Notice } from "../lib/notice";
  import type { Snippet } from "svelte";

  // The settings shell. Every settings screen is the same skeleton — rail,
  // then a content column whose first line is a tabs band (the screen's
  // name, what it currently reads, and a toast when something was just
  // saved), then a list of cards — and until 2026-08-31 all five pasted
  // that skeleton's ~18 lines of CSS into its own style block, where it
  // drifted: integrations' band could not wrap, so a long machine name in
  // the toast pushed the whole document into a horizontal scrollbar that
  // agents' copy had already been fixed for; and the summary rendered in
  // two different faces depending on which screen you were on. One
  // skeleton, one place (#643).
  //
  // The summary is TWO props rather than one, because it says two
  // different things and they read differently on purpose: `count` is how
  // many of a set are live ("1 live", "2 of 5 on") — a quiet aside; `value`
  // is which one is in force right now (a vault path, a chord, a palette) —
  // a machine value, in the same mono face as the toast beside it. Pass
  // exactly one, and pass `undefined` while the answer isn't loaded yet.
  const {
    active,
    extraTab,
    title,
    count,
    value,
    notice = null,
    children,
  }: {
    active: SettingsTab;
    extraTab?: { label: string; active: boolean; onselect: () => void };
    title: string;
    count?: string | undefined;
    value?: string | undefined;
    notice?: Notice | null;
    children: Snippet;
  } = $props();
</script>

<div class="settings">
  <SettingsRail {active} {extraTab} />

  <div class="content">
    <div class="tabs">
      <span class="tab">{title}</span>
      {#if count !== undefined}<span class="tab-sum">{count}</span>{/if}
      {#if value !== undefined}<span class="tab-sum value">{value}</span>{/if}
      {#if notice}<span class="toast" class:err={!notice.ok}>{notice.text}</span>{/if}
    </div>

    <div class="list">{@render children()}</div>
  </div>
</div>

<style>
  /* the app's frame — the rail starts on the app's one left margin */
  .settings { flex: 1; min-height: 0; overflow: auto;
    padding: 26px var(--app-pad-right) 34px var(--app-pad-left);
    display: flex; gap: var(--sp-10); }
  .content { flex: 1; min-width: 0; }

  /* wrap: the toast carries a machine name of unbounded length, and a
     nowrap row pinned right pushes the whole document into a horizontal
     scrollbar on a narrow window. Wrapped, it drops to its own line. */
  .tabs { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-3) var(--sp-7);
    margin-bottom: var(--sp-9); }
  .tab { font: var(--type-eyebrow); letter-spacing: var(--ls-eyebrow); color: var(--text-strong);
    white-space: nowrap; }
  .tab-sum { font: var(--type-meta); color: var(--text-muted); white-space: nowrap; }
  .tab-sum.value { font: var(--type-mono); color: var(--text); }
  .toast { font: var(--type-mono); letter-spacing: 0.08em; color: var(--text-note);
    margin-left: auto; min-width: 0; overflow-wrap: anywhere; }
  .toast.err { color: var(--err); }

  .list { max-width: 720px; display: flex; flex-direction: column; gap: var(--sp-9); }
</style>
