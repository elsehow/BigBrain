<script lang="ts">
  import type { Snippet } from "svelte";

  // One credential in a settings list: what it is, when it was last used,
  // and the one verb it has — REVOKE. Agents (a machine's Claude Code) and
  // integrations (a paired browser) both draw this row, and until
  // 2026-08-31 each drew its own: same four elements, different gaps,
  // different ink, one bordered per row and one bordered once at the top,
  // and a name that wrapped on one screen and overflowed on the other
  // (#643). They are the same list of the same kind of thing, so they are
  // one row now.
  //
  // `extra` is for a badge the row's own screen knows about and this one
  // does not — the TENDER scope chip, so far.
  const {
    name,
    meta,
    busy = false,
    revoking = false,
    onrevoke,
    extra,
  }: {
    name: string;
    meta: string;
    /** any act in flight on this screen — every row's button goes inert */
    busy?: boolean;
    /** this row is the one being revoked */
    revoking?: boolean;
    onrevoke: () => void;
    extra?: Snippet;
  } = $props();
</script>

<div class="conn">
  <span class="conn-name">{name}</span>
  <span class="conn-meta">{meta}</span>
  {@render extra?.()}
  <button class="btn-ghost" disabled={busy} onclick={onrevoke}>
    {revoking ? "REVOKING…" : "REVOKE"}
  </button>
</div>

<style>
  /* wrap + anywhere: a credential's name is a machine name, of unbounded
     length and with no spaces to break at */
  .conn { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3) var(--sp-4);
    padding: 10px 0; border-bottom: 1px solid var(--rule); }
  .conn-name { font: var(--type-body); color: var(--text-strong);
    overflow-wrap: anywhere; min-width: 0; }
  /* flex:1 is what puts REVOKE on the frame's right edge */
  .conn-meta { flex: 1; min-width: 0; font: var(--type-meta); color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
