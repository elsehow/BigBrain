<script lang="ts">
  import { vaultFetch as fetch } from "../lib/vaultScope";

  import { onMount } from "svelte";
  import JevSettings from "./JevSettings.svelte";
  import ModelControls from "./ModelControls.svelte";
  import { api } from "../lib/api";
  import { choiceKey, type ModelAgent, type ModelChoice } from "../lib/modelSettings";
  import { modelsForRole } from "../../../../lib/modelSelection";
  import type { PilotBackendConfig } from "../../../../lib/pilotBackendTypes";
  import type { ModelRole as Role, ModelPreference } from "../../../../lib/modelChoice";
  let preferences = $state<Partial<Record<Role, ModelPreference>>>({});
  let preferenceErrors = $state<Partial<Record<Role, string>>>({});
  let changing = $state<Role | null>(null);
  let recommendations = $state<Partial<Record<Role, ModelChoice>>>({});
  const roles: { id: Role; label: string; note: string }[] = [
    { id: "gardener", label: "Gardener", note: "Files new material into the vault." },
    { id: "memory", label: "Memory", note: "Creates memory notes that give Pilot context." },
    { id: "quick", label: "Quick", note: "Writes orientation notes on nodes and their relationships." },
    { id: "pilot", label: "Pilot", note: "Answers questions and carries out tasks in the app." },
  ];
  let agents = $state<ModelAgent[]>([]), choices = $state<Partial<Record<Role, ModelChoice>>>({});
  let problem = $state(""), loading = $state(true);
  onMount(() => { void load(); });
  async function load() {
    loading = true; problem = "";
    try {
      const models = await fetch("/api/agents/models");
      const [config, backend] = await Promise.all([api.config(), fetch("/api/pilot/chat/backend")]);
      if (!models.ok || !backend.ok) throw new Error("Could not load model settings. Reload to try again.");
      const catalog = await models.json();
      agents = catalog.agents; preferences = catalog.preferences ?? {}; recommendations = catalog.recommendations ?? {};
      const pilot: PilotBackendConfig = await backend.json();
      choices = { gardener: config.gardener, memory: config.memory, quick: config.quick,
        pilot };
    } catch (e) { problem = "Could not load models."; }
    finally { loading = false; }
  }
  async function setPreference(role: Role, preference: ModelPreference) {
    changing = role; preferenceErrors[role] = "";
    try {
      const response = await fetch("/api/models/preference", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role, preference }) });
      if (!response.ok) throw new Error((await response.json()).error ?? "Could not save model preference.");
      await load();
    } catch (error) { preferenceErrors[role] = error instanceof Error ? error.message : String(error); }
    finally { changing = null; }
  }
  async function save(role: Role, choice: ModelChoice) {
    changing = role; preferenceErrors[role] = "";
    try {
    if (role === "pilot") {
      const r = await fetch("/api/pilot/chat/backend", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend: choice }) });
      if (!r.ok) throw new Error((await r.json()).error ?? "Could not save Pilot model.");
    } else {
      await api.saveConfig({ [role]: { ...choice, reasoning: choice.reasoning ?? null } });
    }
    choices = { ...choices, [role]: choice };
    preferences = { ...preferences, [role]: "pinned" };
    } finally { changing = null; }
  }
</script>
<section class="models settings-list">
  <span class="name">Models</span>
  {#if !loading && !problem}
  {#each roles as role (role.id)}
    <div class="role"><span class="role-label">{role.label}</span><div class="options">
      {#if choices[role.id]}
        <ModelControls disabled={changing !== null} label={role.label} value={choices[role.id]!} agents={modelsForRole(agents, role.id)} save={choice => save(role.id, choice)} />
        {#each modelsForRole(agents, role.id).filter(a => a.problem && a.problem !== agents.find(p => p.id === a.id)?.problem) as provider}
          <p>{provider.label}: {provider.problem}</p>
        {/each}
        {#if role.id !== "pilot" && agents.find(a => a.id === choiceKey(choices[role.id]!))?.billing === "api"}
          <p>Runs automatically and bills API usage to this provider. Costs depend on model pricing and the amount of material processed.</p>
        {/if}
        <label class="preference">Selection policy
          <select aria-label={`${role.label} selection policy`} value={preferences[role.id] ?? "pinned"} disabled={changing !== null}
            onchange={event => { const value = event.currentTarget.value as ModelPreference; event.currentTarget.value = preferences[role.id] ?? "pinned"; void setPreference(role.id, value); }}>
            <option value="pinned">Keep this selection</option>
            <option value="recommended">Follow recommendations</option>
          </select>
        </label>
        <p class="hint">{preferences[role.id] === "recommended" ? "Updates with available subscription recommendations. Choosing a model keeps that selection." : "Kept until you choose another model or follow recommendations."}</p>
        {#if !recommendations[role.id] && preferences[role.id] === "recommended"}<p class="hint">No eligible subscription recommendation is currently available. Your last selection is retained.</p>{/if}
        {#if preferenceErrors[role.id]}<p role="alert">{preferenceErrors[role.id]}</p>{/if}
      {/if}
    </div></div>
  {/each}
  {/if}
  <JevSettings />
  {#if loading}<p role="status">Loading models…</p>{/if}
  {#each agents.filter(a => a.problem) as agent}<p role="alert">{agent.label}: {agent.problem}</p>{/each}
  {#if problem}<p role="alert">{problem} <button class="recommended" onclick={load}>Retry</button></p>{/if}
</section>
<style>
  .name { font: var(--type-body); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  p { margin: 0; font: var(--type-body); color: var(--text-note); }
  .role { display:grid; grid-template-columns:90px minmax(0,1fr); gap:16px; align-items:center; padding:12px 0; border-bottom:1px solid var(--rule); } .role-label { font:var(--type-body); }
  @media(max-width:600px) { .role { grid-template-columns:1fr; gap:8px; } }
  .preference { display: grid; gap: var(--sp-2); font: var(--type-meta); }
  .preference select { width: 100%; padding: 8px; color: var(--fg); background: var(--well); border: 1px solid var(--rule); font: var(--type-body); }
  .hint { font: var(--type-meta); color: var(--text-muted); }
  .options { display: flex; flex-direction: column; gap: var(--sp-2); }
  .recommended { align-self:start; font:var(--type-meta); background:none; border:0; color:var(--text-muted); text-decoration:underline; cursor:pointer; padding:0; }
  [role=alert] { color: var(--accent-2); }
</style>
