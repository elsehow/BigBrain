<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import SettingsPage from "../../components/SettingsPage.svelte";
  import { activation } from "./state.svelte";
  import { SOURCES, transition, type Action, type Source } from "./activation";
  const flow = $derived(activation.value);
  const setup = $derived(flow.setup);
  const count = $derived(Object.values(flow.integrations).filter(item => item.active).length);
  let heading = $state<HTMLHeadingElement>();
  let status = $state("");
  async function act(action: Action) {
    const source = flow.setup?.source;
    activation.value = transition(flow, action);
    status = action.type === "finish" && source && !activation.value.setup ? `${SOURCES[source].name} active.`
      : action.type === "deactivate" ? `${SOURCES[action.source].name} inactive.` : "";
    await tick();
    if (activation.value.setup) heading?.focus();
    else if (source) document.getElementById(`activate-${source}`)?.focus();
  }
  // Leaving Settings cancels incomplete setup, while completed configuration stays.
  onDestroy(() => { activation.value = transition(activation.value, { type: "cancel" }); });
</script>

<SettingsPage active="integrations" title="INTEGRATIONS" count={`${count} of 2 active`}>
  {#each Object.entries(SOURCES) as [key, source]}
    {@const id = key as Source}
    {@const integration = flow.integrations[id]}
    <section class="item" aria-label={source.name}>
      <div class="row">
        <div class="info"><span class="name">{source.name}</span><span class="status">{integration.active ? "Active" : "Inactive"}{id === "that-tracks" ? " · Proposed" : ""}</span></div>
        <button id={`activate-${id}`} class="btn-ghost" disabled={!!setup}
          onclick={() => act(integration.active ? { type: "deactivate", source: id } : { type: "begin", source: id })}>
          {integration.active ? "Deactivate" : "Activate"}
        </button>
      </div>
      {#if setup?.source === id}
        <div class="cfg-edit">
          <span class="cfg-label">{setup.step === "rule" ? "2 / 2" : "1 / 2"}</span>
          <div class="cfg-body">
            <h3 bind:this={heading} tabindex="-1">{setup.step === "rule" ? "Remembering rule" : "Connect account"}</h3>
            {#if setup.step === "account"}
              {#if setup.error}<p role="alert" class="status">{setup.error}</p>{/if}
              <div class="row-actions"><button class="btn-save" onclick={() => act({ type: "connect" })}>{setup.error ? "Try again" : `Connect ${source.name}`}</button><button class="btn-ghost" onclick={() => act({ type: "cancel" })}>Cancel</button></div>
            {:else if setup.step === "review"}
              <p class="account">{source.account}</p><p class="status">{source.scope}</p>
              <div class="row-actions"><button class="btn-save" onclick={() => act({ type: "allow" })}>Allow access</button><button class="btn-ghost" onclick={() => act({ type: "back" })}>Back</button><button class="btn-ghost" onclick={() => act({ type: "cancel" })}>Cancel</button></div>
            {:else}
              <label class="sr-only" for={`rule-${id}`}>{source.name} remembering rule</label>
              <textarea id={`rule-${id}`} value={setup.draft} rows="6" oninput={event => { activation.value = transition(flow, { type: "edit", value: event.currentTarget.value }); }} aria-describedby={!setup.draft.trim() ? `validation-${id}` : undefined}></textarea>
              {#if !setup.draft.trim()}<p id={`validation-${id}`} class="status">Enter a rule to activate.</p>{/if}
              <div class="row-actions"><button class="btn-save" disabled={!setup.authenticated || !setup.draft.trim()} onclick={() => act({ type: "finish" })}>Finish & activate</button><button class="btn-ghost" onclick={() => act({ type: "back" })}>Back</button><button class="btn-ghost" onclick={() => act({ type: "cancel" })}>Cancel</button></div>
            {/if}
          </div>
        </div>
      {/if}
    </section>
  {/each}
  <p class="status" role="status">{status}</p>
</SettingsPage>

<style>
  /* Match IntegrationsView's item/row/config conventions within the real SettingsPage. */
  .item { display: flex; flex-direction: column; gap: var(--sp-4); }
  .row { display: flex; justify-content: space-between; align-items: start; gap: var(--sp-7); }
  .info { display: flex; flex-direction: column; gap: var(--sp-2); }
  .name { font: var(--type-heading); letter-spacing: var(--ls-heading); }
  .status { font: var(--type-meta); color: var(--text-muted); margin: 0; }
  .cfg-edit { display: grid; grid-template-columns: 132px 1fr; gap: var(--sp-6); align-items: start; padding: var(--sp-4) 0 0; }
  .cfg-label { font: var(--type-eyebrow); letter-spacing: var(--ls-eyebrow); color: var(--text-faint); padding-top: var(--sp-3); }
  .cfg-body { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
  h3 { font: var(--type-body); font-weight: var(--fw-medium); margin: 0; } h3:focus { outline: none; }
  .account { margin: 0; font: var(--type-body); }
  .row-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-3); }
  textarea { resize: vertical; width: 100%; box-sizing: border-box; min-height: 168px; font: var(--type-body); color: var(--text); background: var(--well); border: 1px solid var(--rule); border-radius: var(--r-chip); padding: 13px 16px; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button { max-width: 100%; white-space: normal; }
  :is(button, textarea):focus-visible { outline: 2px solid var(--activity); outline-offset: 3px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media(max-width: 700px) { .cfg-edit { grid-template-columns: 1fr; gap: var(--sp-3); } .row { flex-wrap: wrap; } }
</style>
