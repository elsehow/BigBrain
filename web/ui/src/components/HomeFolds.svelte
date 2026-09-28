<script lang="ts">
  // The fold proposals on home (#728): the memory pass's "same thing?"
  // groups, above the feed, so they get triaged. This owns the door —
  // reads /api/entity/folds on every live ping like the feed, writes the
  // two acts, re-reads after each — and EntityFolds owns the row. An
  // engine without the door (404) or with nothing proposed renders
  // nothing at all: the block exists only while there is a decision.
  import EntityFolds from "./EntityFolds.svelte";
  import { api, swr } from "../lib/api";
    import { liveResource } from "../lib/liveResource.svelte";
  import type { FoldMember, FoldsView } from "../lib/types";

  let view = $state<FoldsView | null>(null);
  let error = $state<string | null>(null);
  // A mutation may have made the cached proposals obsolete.
  liveResource(() => "folds", () => swr.folds(), v => { view = v; }, {
    cache: false, onError: () => { view = null; },
  });

  const refresh = async (): Promise<void> => {
    try { view = await api.folds(); } catch { /* the next ping re-reads */ }
  };
  // Both acts throw on a refusal AFTER showing it, so EntityFolds leaves
  // the row as it was; either way the record is re-read.
  async function accept(canonical: FoldMember, others: FoldMember[]): Promise<void> {
    error = null;
    try {
      await api.acceptFold(canonical.id, others.map((m) => m.id));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      await refresh();
    }
  }
  async function reject(member: FoldMember, others: FoldMember[]): Promise<void> {
    error = null;
    try {
      await api.rejectFold(member.id, others.map((m) => m.id));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      await refresh();
    }
  }
</script>

{#if view && view.groups.length}
  <div class="home-folds">
    <!-- NOT keyed: an accept or reject re-reads, and EntityFolds
         reconciles the record's answer into its rows — a remount here
         would drop the pill you just picked and the FOLDED line you just
         earned. -->
    <EntityFolds groups={view.groups} onaccept={accept} onreject={reject} />
    {#if error}<p class="err">{error}</p>{/if}
  </div>
{/if}

<style>
  /* The fixed graph is z=0 in the production shell; review owns its pixels and input. */
  .home-folds { position: relative; z-index: 1; margin: var(--sp-6) 0 var(--sp-8); }
  .err { font: var(--type-meta); color: var(--err); margin: var(--sp-3) 0 0; }
</style>
