<script lang="ts">
  import { vaultFetch as fetch } from "../lib/vaultScope";

  import { onMount, untrack } from "svelte";
  import ModelControls from "./ModelControls.svelte";
  import { modelsForRole } from "../../../../lib/modelSelection";
  import { choiceKey, type ModelAgent, type ModelChoice } from "../lib/modelSettings";
  import { updateChatBackend } from "../lib/pilotChat.svelte";
  import { DEFAULT_PILOT_BACKEND, type PilotBackendConfig } from "../../../../lib/pilotBackendTypes";
  const { id, value, disabled = false, ondone }: { id?: string; value?: PilotBackendConfig; disabled?: boolean; ondone?: () => void } = $props();
  const initial = untrack(() => value ?? DEFAULT_PILOT_BACKEND);
  let choice = $state<ModelChoice>(initial);
  let savedChoice = $state<ModelChoice>(initial);
  const changed = $derived(choiceKey(choice) !== choiceKey(savedChoice) || choice.model !== savedChoice.model || (choice.reasoning ?? "") !== (savedChoice.reasoning ?? ""));
  let agents = $state<ModelAgent[]>([]), problem = $state(""), loading = $state(true);
  onMount(() => { void load(); });
  async function load() {
    try {
      const r = await fetch("/api/pilot/chat/models");
      if (!r.ok) throw new Error("Could not load connected models.");
      agents = modelsForRole((await r.json()).agents, "pilot");
      if (!id) {
        const r = await fetch("/api/pilot/chat/backend");
        if (!r.ok) throw new Error("Could not load Pilot settings.");
        const c = await r.json(); choice = c; savedChoice = { ...choice };
      }
    } catch (e) { problem = e instanceof Error ? e.message : String(e); }
    finally { loading = false; }
  }
  let saving = $state(false);
  async function finish() {
    if (saving) return;
    if (!changed) { ondone?.(); return; }
    if (disabled || loading) return;
    saving = true; problem = "";
    try { await save(choice); ondone?.(); }
    catch (e) { problem = e instanceof Error ? e.message : "Could not save model."; }
    finally { saving = false; }
  }
  async function save(next: ModelChoice) {
    const backend = next;
    if (id) await updateChatBackend(id, backend);
    else {
      const r = await fetch("/api/pilot/chat/backend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend }) });
      if (!r.ok) throw new Error((await r.json()).error ?? "Could not save Pilot model.");
    }
    choice = next; savedChoice = { ...next };
  }
</script>
<div class="picker-row" class:compact={!!ondone}>
<div class="model-fields"><ModelControls deferred={!!ondone} label="Pilot" value={choice} {agents} disabled={disabled || loading || saving} save={ondone ? async next => { choice = next; } : save} /></div>
{#if ondone}<button class="save-close" aria-label={changed ? "Save model and close" : "Close model settings"} disabled={saving || (changed && (disabled || loading))} onclick={finish}>{saving ? "Saving…" : "✓"}</button>{/if}
</div>
{#each agents.filter(a => a.problem) as agent}<p>{agent.label}: {agent.problem}</p>{/each}
{#if problem}<p role="alert">{problem}</p>{/if}
<style>
  .compact { display:flex; align-items:flex-end; gap:10px; }
  .model-fields { min-width:0; flex:1; }
  .compact :global(.controls) { flex-wrap:nowrap; gap:8px; }
  .compact :global(label) { min-width:0; gap:4px; }
  .compact :global(.model) { min-width:0; }
  .compact :global(select) { padding:6px 8px; }
  .compact .save-close { flex:none; min-height:36px; margin:0; }
  .save-close:disabled { opacity:.35; cursor:default; }
  .save-close { display:block; margin:10px 0 0 auto; border:1px solid var(--rule); border-radius:4px; padding:6px 12px; background:var(--bg); color:var(--text); cursor:pointer; } p { font: var(--type-meta); color: var(--text-muted); margin: var(--sp-2) 0; }</style>
