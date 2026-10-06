<script lang="ts">
  // Settings → security: what the app may load from the web. One switch for
  // every kind of source for now: a source's images, and its page read in
  // full. The engine holds it (vault.yaml security.remote_content) and
  // refuses the fetch when it is off, so the switch is the rule, not a hint.
  //
  // And the intake firewall (lib/firewall.ts), which screens with Jev: on by
  // default once a Jev key is set, off without one. The owner's choice is
  // vault.yaml security.firewall; the switch shows what the engine will do.
  import SettingsPage from "./SettingsPage.svelte";
  import { api } from "../lib/api";
  import type { Notice } from "../lib/notice";
  import { tooltip } from "../lib/tooltip";
  import type { Instance } from "tippy.js";

  const NO_KEY = "Add a Jev key to use the firewall.";

  let remote = $state<boolean | null>(null);
  let firewall = $state<boolean | null>(null);
  let jevKey = $state(false);
  let notice = $state<Notice | null>(null);
  let saving = $state(false);
  let firewallSwitch = $state<HTMLButtonElement>();

  $effect(() => {
    api.config().then((c) => {
      remote = c.security?.remote_content ?? true;
      firewall = c.security?.firewall ?? false;
      jevKey = c.security?.jev_key ?? false;
    }).catch(() => { remote = true; firewall = false; });
  });

  async function setRemote(on: boolean): Promise<void> {
    if (saving) return;
    saving = true;
    const was = remote;
    remote = on;
    try {
      await api.saveConfig({ security: { remote_content: on } });
      notice = { ok: true, text: on ? "remote content on" : "remote content off" };
    } catch (e) {
      remote = was;
      notice = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally { saving = false; }
  }

  async function setFirewall(on: boolean): Promise<void> {
    if (saving) return;
    // No key, nothing to screen with: the switch stays off and says why.
    if (on && !jevKey) {
      (firewallSwitch as (HTMLButtonElement & { _tippy?: Instance }) | undefined)?._tippy?.show();
      return;
    }
    saving = true;
    const was = firewall;
    firewall = on;
    try {
      await api.saveConfig({ security: { firewall: on } });
    } catch (e) {
      firewall = was;
      notice = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally { saving = false; }
  }
</script>

<SettingsPage active="security" title="SECURITY" value={remote == null ? undefined : remote ? "remote content on" : "remote content off"} {notice}>
  <section class="item" aria-label="Remote content">
    <span class="name">Remote content</span>
    <label class="choice">
      <button class="switch" class:on={remote} role="switch" aria-checked={!!remote} disabled={remote == null || saving}
        aria-label="Load remote content" onclick={() => void setRemote(!remote)}><span class="knob"></span></button>
      <span>Load images and full pages from the web</span>
    </label>
    <p class="note">Load images and (when necessary) articles from remote URLs.</p>
  </section>
  <section class="item" aria-label="Firewall">
    <span class="name">Firewall</span>
    <div class="choice">
      <!-- Not `disabled` without a key: a disabled button gets no pointer
           events, so trying it could not show the tooltip. -->
      <button bind:this={firewallSwitch} class="switch" class:on={firewall} role="switch" aria-checked={!!firewall}
        aria-disabled={!jevKey} disabled={firewall == null || saving} aria-label="Firewall"
        use:tooltip={firewall != null && !jevKey ? NO_KEY : undefined}
        onclick={() => void setFirewall(!firewall)}><span class="knob"></span></button>
    </div>
  </section>
</SettingsPage>

<style>
  .item { display: flex; flex-direction: column; gap: var(--sp-5); }
  .name { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  .choice { display: flex; align-items: center; gap: var(--sp-3); font: var(--type-body); color: var(--text); cursor: pointer; }
  .note { margin: 0; max-width: 520px; font: var(--type-body); color: var(--text-faint); }
  .switch { flex: none; position: relative; width: 34px; height: 20px; border: 1px solid var(--rule); border-radius: 999px; background: var(--surface); cursor: pointer; padding: 2px; }
  .switch.on { background: var(--text-strong); border-color: var(--text-strong); }
  .switch:disabled, .switch[aria-disabled="true"] { cursor: default; opacity: .6; }
  .knob { display: block; width: 14px; height: 14px; border-radius: 50%; background: var(--text-muted); transition: transform var(--dur-fast) var(--ease); }
  .switch.on .knob { transform: translateX(14px); background: var(--bg); }
</style>
