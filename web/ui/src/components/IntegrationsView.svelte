<script lang="ts">
  import IntegrationAccountSettings from "./IntegrationAccountSettings.svelte";
  import { onMount } from "svelte";
  import IntegrationLibrary from "./IntegrationLibrary.svelte";
  import SettingsPage from "./SettingsPage.svelte";
  import { api } from "../lib/api";
  import { guardNotice, type Notice } from "../lib/notice";
  import { app } from "../lib/store.svelte";
  import { tooltip } from "../lib/tooltip";
  import type { IntegrationInfo, IntegrationSource } from "../lib/types";

  // What each known integration is for. vault.yaml stays schema-less (keys
  // pass through opaquely), so the words live here, next to the UI.
  const ABOUT: Record<string, string> = {
    granola: "Include Granola transcripts in your vault.",
    "that-tracks": "Keep your tracked events and journal entries in your vault.",
    email: "Include emails in your vault.",
  };

  let integrations = $state<IntegrationInfo[]>([]);
  let loaded = $state(false);
  let busy = $state<string | null>(null); // integration name mid-save
  let editing = $state<string | null>(null); // name whose config editor is open
  // Credential inputs, keyed by env var. Non-secret fields prefill with the
  // current value; secret fields start BLANK — blank means "leave as is",
  // typing replaces. The existing secret is never in this state.
  let envEdits = $state<Record<string, string>>({});
  let adding = $state<string | null>(null); // name whose add-a-source form is open
  let fixing = $state<string | null>(null); // the source the open form is re-crediting, if any
  let addEdits = $state<Record<string, string>>({});
  let notice = $state<Notice | null>(null);


  async function load(): Promise<void> {
    try {
      // External conversation capture is retired.
      integrations = ((await api.config()).integrations ?? []).filter((i) => !["agent-chat", "granola", "email", "that-tracks"].includes(i.name));
    } catch {
      integrations = [];
    }
    loaded = true;
  }
  // initial load, then again on every live ping (vault.yaml is watched).
  // Credential inputs live in envEdits, which load() never touches, so a ping
  // mid-edit cannot clobber what is being typed.
  $effect(() => { void app.rev; void load(); });

  // Poll health changes even on a quiet vault; .state is deliberately not
  // watched by the graph's SSE stream. Refresh only while this view exists.
  onMount(() => { const timer = setInterval(() => void load(), 15_000); return () => clearInterval(timer); });

  async function setEnabled(i: IntegrationInfo, on: boolean): Promise<void> {
    if (i.activation) return;
    busy = i.name;
    await guardNotice(
      (n) => (notice = n),
      async () => {
        const r = await api.saveConfig({ integrations: [{ name: i.name, enabled: on }] });
        notice = {
          ok: true,
          text: r.changed.length
            ? `${i.name} ${on ? "active" : "inactive"} — saved evidence is retained`
            : "no change",
        };
        await load();
      }
    );
    busy = null;
  }

  // A source (an inbox, a calendar feed): the add form is the integration's
  // own field list; a secret is write-only, same as the key editor.
  function startAdd(i: IntegrationInfo, src?: IntegrationSource): void {
    adding = i.name;
    fixing = src?.id ?? null;
    // a fix is the same form with the source's own fields filled — only the
    // secret is blank, and it is the one thing to retype
    addEdits = Object.fromEntries(
      (i.add?.fields ?? []).map((f) => [f.key, (!f.secret && src?.fields?.[f.key]) || f.default || ""])
    );
    editing = null;
    notice = null;
  }

  async function removeSource(i: IntegrationInfo, src: IntegrationSource): Promise<void> {
    busy = i.name;
    await guardNotice(
      (n) => (notice = n),
      async () => {
        const r = await api.saveConfig({ integrations: [{ name: i.name, remove: src.id }] });
        notice = { ok: true, text: r.changed.length ? `${src.label} removed — what it landed stays in the vault` : "no change" };
        if (fixing === src.id) { adding = null; fixing = null; }
        await load();
      }
    );
    busy = null;
  }

  async function saveAdd(i: IntegrationInfo): Promise<void> {
    const add: Record<string, string> = {};
    for (const f of i.add?.fields ?? []) {
      const v = (addEdits[f.key] ?? "").trim();
      if (v) add[f.key] = v;
    }
    const first = i.add?.fields[0];
    if (!first || !add[first.key]) {
      notice = { ok: false, text: `${first?.label ?? "a value"} is required` };
      return;
    }
    busy = i.name;
    await guardNotice(
      (n) => (notice = n),
      async () => {
        const r = await api.saveConfig({ integrations: [{ name: i.name, add }] });
        notice = { ok: true, text: r.changed.length ? `${add[first.key]} connected — ${fixing ? "updated" : "added"}` : "no change" };
        adding = null;
        fixing = null;
        await load();
      }
    );
    busy = null;
  }

  function startEdit(i: IntegrationInfo): void {
    editing = i.name;
    envEdits = Object.fromEntries(i.env.map((f) => [f.env, f.secret ? "" : (f.value ?? "")]));
    notice = null;
  }

  async function saveCfg(): Promise<void> {
    const name = editing!;
    const info = integrations.find((x) => x.name === name);
    busy = name;
    // only send credentials that were actually (re)typed — a blank secret
    // input means "unchanged", and an unchanged non-secret value is a no-op
    const env: Record<string, string> = {};
    for (const f of info?.env ?? []) {
      const v = (envEdits[f.env] ?? "").trim();
      if (v && (f.secret || v !== (f.value ?? ""))) env[f.env] = v;
    }
    await guardNotice(
      (n) => (notice = n),
      async () => {
        const r = await api.saveConfig({
          // NO configYaml: the raw-YAML editor is gone, and sending the key at
          // all would REPLACE the integration's opaque block wholesale. Omitting
          // it takes applyIntegrationOps' other branch, which leaves that block
          // exactly as it was.
          integrations: [{ name, ...(Object.keys(env).length ? { env } : {}) }],
        });
        notice = { ok: true, text: r.changed.length ? `${name} configured — takes effect on its next run` : "no changes to save" };
        editing = null;
        await load();
      }
    );
    busy = null;
  }
</script>

  <SettingsPage active="integrations" title="INTEGRATIONS" {notice}>
    {#if !loaded}
      <p class="empty">Loading…</p>
    {:else}
      <IntegrationLibrary />

      {#each integrations as i (i.name)}
        <div class="item">
          <div class="row" class:off={!i.enabled && !i.activation}>
            <div class="row-main">
              <h2 class="name">{i.name === "that-tracks" ? "That Tracks" : i.name === "granola" ? "Granola" : i.name === "email" ? "Email" : i.name}</h2>
              {#if i.name === "email"}<span class="status">Legacy IMAP</span>{/if}
              {#if i.name === "that-tracks"}<span class="status">Legacy · MCP support coming later</span>{/if}
              <span class="about">{ABOUT[i.name] ?? `No description — see integrations/${i.name}/run.ts.`}</span>
              {#if i.status}
                <span class="status" class:warn={i.status.state === "error"}
                  title={i.status.lastArrivalAt ? `Last arrival: ${new Date(i.status.lastArrivalAt).toLocaleString()}` : undefined}>
                  {i.status.label}{#if i.status.checkedAt}{" · checked "} {new Date(i.status.checkedAt).toLocaleString()}{/if}
                </span>
              {/if}
              <!-- A configured entry without shipped code cannot run. -->
              {#if !i.hasCode}
                <span class="status warn">declared in vault.yaml, but no runner code for it</span>
              {/if}
              {#if i.env.length && !i.activation}
                <button class="cfg-toggle" disabled={busy !== null}
                  onclick={() => (editing === i.name ? (editing = null) : startEdit(i))}>
                  <span>CONFIGURE</span>
                  <svg width="12" height="8" viewBox="0 0 14 9" fill="none" stroke="var(--icon)"
                    stroke-width="2" stroke-linecap="round" aria-hidden="true"
                    style:transform={editing === i.name ? "rotate(180deg)" : ""}><path d="M1 1.5l6 6 6-6" /></svg>
                </button>
              {/if}
            </div>
            {#if !i.activation}<button class="tog" class:on={i.enabled} role="switch" aria-checked={i.enabled}
              aria-label="toggle {i.name}" disabled={busy !== null}
              use:tooltip={i.enabled ? `Turn ${i.name} off — its config is kept` : `Turn ${i.name} on`}
              onclick={() => setEnabled(i, !i.enabled)}>
              <span class="knob"></span>
            </button>{/if}
          </div>

          {#if i.activation}
            {#key i.name + JSON.stringify(i.activation.accounts)}<IntegrationAccountSettings source={i.name}/>{/key}
          {/if}

          {#if i.sources}
            <!-- what it reads, one line each: the last poll's word as a dot,
                 and its reason when not ok -->
            <div class="srcs">
              {#each i.sources as src (src.id)}
                <div class="src">
                  <span class="dot" class:ok={src.status === "ok"} class:warn={src.status === "failed"}></span>
                  <span class="src-label">{src.label}</span>
                  {#if src.detail}<span class="src-detail" class:warn={src.status === "failed"}>{src.detail}</span>{/if}
                  <span class="src-acts">
                    {#if src.status !== "ok" && i.add}
                      <button class="btn-ghost src-fix" disabled={busy !== null} onclick={() => startAdd(i, src)}>FIX</button>
                    {/if}
                    <button class="src-x" disabled={busy !== null} aria-label="remove {src.label}"
                      use:tooltip={`Remove ${src.label} — what it landed stays`} onclick={() => removeSource(i, src)}>×</button>
                  </span>
                </div>
              {/each}
              {#if i.add && i.name !== "email"}
                <button class="cfg-toggle" disabled={busy !== null}
                  onclick={() => (adding === i.name && !fixing ? (adding = null) : startAdd(i))}>
                  <span>{i.add.label}</span>
                  <svg width="12" height="8" viewBox="0 0 14 9" fill="none" stroke="var(--icon)"
                    stroke-width="2" stroke-linecap="round" aria-hidden="true"
                    style:transform={adding === i.name && !fixing ? "rotate(180deg)" : ""}><path d="M1 1.5l6 6 6-6" /></svg>
                </button>
              {/if}
            </div>
          {/if}

          {#if adding === i.name && i.add}
            <div class="cfg-edit">
              <span class="cfg-label">{fixing ? "fix" : "new"} {i.add.noun}</span>
              <div class="cfg-body">
                <div class="keys">
                  {#each i.add.fields as f (f.key)}
                    <label class="key-row">
                      <span class="key-label">{f.label}</span>
                      {#if f.secret}
                        <input class="mono" type="password" bind:value={addEdits[f.key]}
                          autocomplete="new-password" spellcheck="false" placeholder={f.placeholder ?? ""} />
                      {:else}
                        <input class="mono" type="text" bind:value={addEdits[f.key]} spellcheck="false"
                          autocomplete="off" placeholder={f.placeholder ?? ""} />
                      {/if}
                    </label>
                  {/each}
                </div>
                <div class="row-actions">
                  <!-- the engine logs in before it writes, so a bad password
                       or host comes back as the toast and nothing is saved -->
                  <button class="btn-save" disabled={busy !== null} onclick={() => saveAdd(i)}>{busy === i.name ? "CONNECTING…" : "SAVE"}</button>
                  <button class="btn-ghost" disabled={busy !== null} onclick={() => { adding = null; fixing = null; }}>CANCEL</button>
                </div>
              </div>
            </div>
          {/if}

          {#if editing === i.name && !i.activation}
            <div class="cfg-edit">
              <span class="cfg-label">CONFIG</span>
              <div class="cfg-body">
                {#if i.name === "that-tracks"}
                  <p class="about">In That Tracks, open Settings → Account &amp; sync → API keys.
                    Create a read-only key named BigBrain and paste it here. All history and future
                    entries the key permits can be remembered. Turning this off
                    stops syncing and live reads; previously imported history stays in your vault.</p>
                {/if}
                {#if i.env.length && !i.activation}
                  <div class="keys">
                    {#each i.env as f (f.env)}
                      <label class="key-row">
                        <span class="key-label">{f.label}
                          <span class="key-state" class:unset={!f.set}>{f.set ? "set" : "not set"}</span>
                        </span>
                        {#if f.secret}
                          <input class="mono" type="password" bind:value={envEdits[f.env]}
                            autocomplete="new-password" spellcheck="false"
                            placeholder={f.set ? "•••••••• — type to replace" : "paste key"} />
                        {:else}
                          <input class="mono" type="text" bind:value={envEdits[f.env]} spellcheck="false" />
                        {/if}
                      </label>
                    {/each}
                  </div>
                {/if}
                <div class="row-actions">
                  <button class="btn-save" disabled={busy !== null} onclick={saveCfg}>{busy === i.name ? "SAVING…" : "SAVE"}</button>
                  <button class="btn-ghost" disabled={busy !== null} onclick={() => (editing = null)}>CANCEL</button>
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </SettingsPage>

<style>
  .row { display: flex; align-items: flex-start; gap: var(--sp-6); }
  .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  .name { margin:0; font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  .about { font: var(--type-body); color: var(--text-note); max-width: 520px; }
  .status { font: var(--type-meta); color: var(--text-muted); }
  .status.warn { color: var(--warn); }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: var(--r-full);
    background: var(--text-faint); margin-right: var(--sp-3); vertical-align: 1px; flex: none; }
  .dot.ok { background: var(--accent-3); }
  .dot.warn { background: var(--warn); }
  .row.off .name, .row.off .about { opacity: 0.55; }

  /* the sources: one line each, then the add button */
  .srcs { display: flex; flex-direction: column; gap: var(--sp-3); padding-top: var(--sp-4); }
  .src { display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
  .src-label { font: var(--type-body); color: var(--text); overflow-wrap: anywhere; }
  .src-detail { font: var(--type-meta); color: var(--text-muted); white-space: nowrap; }
  .src-detail.warn { color: var(--warn); }
  /* the acts, right-aligned: FIX as a small chip when the last poll failed,
     and the × in the row switch's column */
  .src-acts { margin-left: auto; display: flex; align-items: center; gap: var(--sp-2); flex: none; }
  .src-fix { padding: 4px 10px; font: var(--type-eyebrow); letter-spacing: var(--ls-eyebrow); }
  .src-x { width: 46px; border: none; background: none; padding: 0; cursor: pointer;
    font: var(--type-body); font-size: 18px; line-height: 1; color: var(--text-faint); }
  .src-x:hover:enabled { color: var(--text); }
  .src-x:disabled { opacity: 0.5; cursor: default; }
  .srcs .cfg-toggle { margin-top: var(--sp-1); }

  .cfg-toggle { display: flex; align-items: center; gap: var(--sp-2); cursor: pointer;
    border: none; background: none; padding: 0; margin-top: var(--sp-2);
    font: var(--type-eyebrow); letter-spacing: var(--ls-eyebrow); color: var(--text-faint); }
  .cfg-toggle:hover:enabled { color: var(--text); }
  .cfg-toggle:disabled { opacity: 0.5; cursor: default; }
  .cfg-toggle svg { display: block; transition: transform var(--dur-fast) var(--ease); }

  /* the mockup's 46×26 pill toggle — ink track + white knob when on */
  .tog { width: 46px; height: 26px; border-radius: var(--r-full); border: none;
    background: var(--well); display: flex; align-items: center; padding: 3px;
    cursor: pointer; flex: none; margin-top: var(--sp-1); }
  .tog .knob { width: 20px; height: 20px; border-radius: var(--r-full);
    background: var(--ink-100); margin-left: 0; box-shadow: var(--shadow-knob);
    transition: margin-left var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease); }
  .tog.on { background: var(--text-strong); }
  .tog.on .knob { margin-left: 20px; background: var(--bg); }
  .tog:disabled { opacity: 0.5; cursor: default; }

  .cfg-edit { display: grid; grid-template-columns: 132px 1fr; gap: var(--sp-6);
    align-items: start; padding: var(--sp-4) 0 0; }
  .cfg-label { font: var(--type-eyebrow); letter-spacing: var(--ls-eyebrow);
    color: var(--text-faint); padding-top: var(--sp-3); text-transform: uppercase; }
  .cfg-body { display: flex; flex-direction: column; gap: var(--sp-3); max-width: 420px; }

  .keys { display: flex; flex-direction: column; gap: var(--sp-3); padding-bottom: var(--sp-3); }
  .key-row { display: flex; flex-direction: column; gap: var(--sp-2); }
  .key-label { font: var(--type-eyebrow); letter-spacing: var(--ls-eyebrow); color: var(--text-faint);
    text-transform: uppercase; display: flex; align-items: baseline; gap: var(--sp-3); }
  .key-state { font: var(--type-meta); letter-spacing: 0; color: var(--ok); text-transform: none; }
  .key-state.unset { color: var(--err); }
  .key-row input.mono { font-family: var(--font-mono); font-size: 12px; color: var(--text-note);
    background: var(--well); border: none; border-radius: var(--r-chip); padding: 11px 16px;
    letter-spacing: 0.04em; }
  .key-row input.mono:focus { outline: none; box-shadow: inset 0 0 0 1px var(--dash); }

  .row-actions { display: flex; align-items: center; gap: var(--sp-3); }
</style>
