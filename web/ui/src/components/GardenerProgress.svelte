<script lang="ts">
  import type { GardenerProgress } from "../../../../lib/gardenerProgressTypes";
  import { tooltip } from "../lib/tooltip";
  let { progress }: { progress: GardenerProgress } = $props();
  const action = $derived(progress.phase === "starting" ? "Starting"
    : progress.phase === "reading" ? "Reading material"
    : progress.phase === "context" ? "Checking existing notes"
    : progress.phase === "saving" ? "Saving claims"
    : progress.phase === "checking" ? "Checking arrivals"
    : progress.phase === "finishing" ? "Finishing"
    : progress.phase === "retrying" ? "Retrying a step"
    : `Reviewing ${progress.batch} arrival${progress.batch === 1 ? "" : "s"}`);
  const filed = $derived(`${progress.claims} claim${progress.claims === 1 ? "" : "s"} filed`);
  const detail = $derived(`${progress.waitingForModel ? "Waiting for model" : "Running vault tools"}. ${filed}. Last activity ${new Date(progress.updatedAt).toLocaleTimeString()}.`);
</script>

<div class="progress" role="status" use:tooltip={detail}>
  <span class="label">Gardener</span><span>{action}</span>
  {#if progress.claims}<span class="filed">{filed}</span>{/if}
  {#if progress.waitingForModel}<span class="waiting">Waiting for model</span>{/if}
</div>

<style>
  .progress { display: flex; align-items: center; gap: 12px; min-width: 0;
    font: var(--type-meta); font-size: 11px; line-height: 18px; color: var(--text-muted); white-space: nowrap; overflow: hidden; }
  .label { color: var(--text-faint); }
  .filed { color: var(--text); }
  .waiting { color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; }
  @media (max-width: 600px) { .waiting { display: none; } }
</style>
