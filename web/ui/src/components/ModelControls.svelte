<script lang="ts">
  import { changeModel, latestModels, reasoningOptions, choiceKey, type ModelAgent, type ModelChoice } from "../lib/modelSettings";
  const { label, agents, value, disabled = false, deferred = false, save }: {
    label: string; agents: ModelAgent[]; value: ModelChoice; disabled?: boolean; deferred?: boolean;
    save: (choice: ModelChoice) => Promise<void>;
  } = $props();
  let busy = $state(false), error = $state(""), saved = $state(false);
  const selected = $derived(`${choiceKey(value)}:${value.model}`);
  const menus = $derived(agents.map(a => ({ ...a, models: latestModels(a.models, a.id === choiceKey(value) ? value.model : undefined) })));
  const known = $derived(agents.some(a => a.id === choiceKey(value) && a.models.some(m => m.id === value.model)));
  const efforts = $derived(reasoningOptions(agents, value));
  const available = $derived(agents.some(a => a.id === choiceKey(value) && a.ready));
  async function commit(next: ModelChoice, target: HTMLSelectElement, previous: string) {
    busy = true; error = ""; saved = false;
    try { await save(next); saved = true; }
    catch (e) { target.value = previous; error = e instanceof Error ? e.message : "Could not save. Try again."; }
    finally { busy = false; }
  }
</script>
<div class="controls" aria-label={`${label} model settings`}>
  <label class="model">Model
    <select aria-label={`${label} model`} value={selected} disabled={disabled || busy}
      onchange={e => void commit(changeModel(agents, value, e.currentTarget.value), e.currentTarget, selected)}>
      {#if !known}<option value={selected} disabled>{value.model || "Choose a model"}</option>{/if}
      {#each menus as agent (agent.id)}
        <optgroup label={`${agent.label}${agent.billing === "api" ? " · API" : agent.billing === "subscription" ? " · subscription" : ""}${agent.ready ? "" : " — not connected"}`} disabled={!agent.ready}>
          {#each agent.models as model (model.id)}<option value={`${agent.id}:${model.id}`}>{model.label}</option>{/each}
        </optgroup>
      {/each}
    </select>
  </label>
  <label>Reasoning
    <select aria-label={`${label} reasoning`} value={value.reasoning ?? ""} disabled={disabled || busy || !available}
      onchange={e => void commit({ ...value, reasoning: e.currentTarget.value || undefined }, e.currentTarget, value.reasoning ?? "")}>
      <option value="">Default</option>
      {#if value.reasoning && !efforts.includes(value.reasoning)}<option value={value.reasoning} disabled>{value.reasoning} (saved)</option>{/if}
      {#each efforts as effort}<option value={effort}>{effort[0].toUpperCase() + effort.slice(1)}</option>{/each}
    </select>
  </label>
</div>
{#if error}<p role="alert">{error}</p>{:else if !deferred && (busy || saved)}<p role="status">{busy ? "Saving…" : deferred ? "Ready to save" : "Saved"}</p>{/if}
<style>
  .controls { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
  label { display: grid; gap: var(--sp-2); font: var(--type-meta); color: var(--text-muted); min-width: 120px; }
  .model { flex: 1; min-width: 200px; }
  select { width: 100%; font: var(--type-body); padding: 8px 10px; color: var(--text); background: var(--surface); border: 1px solid var(--rule); border-radius: var(--r-sm); }
  p { font: var(--type-meta); color: var(--text-muted); margin: var(--sp-2) 0 0; } [role=alert] { color: var(--accent-2); }
</style>
