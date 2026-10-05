<script lang="ts">
  // Settings → security: what the app may load from the web. One switch for
  // every kind of source for now: a source's images, and its page read in
  // full. The engine holds it (vault.yaml security.remote_content) and
  // refuses the fetch when it is off, so the switch is the rule, not a hint.
  import SettingsPage from "./SettingsPage.svelte";
  import { api } from "../lib/api";
  import type { Notice } from "../lib/notice";

  let remote = $state<boolean | null>(null);
  let notice = $state<Notice | null>(null);
  let saving = $state(false);

  $effect(() => {
    api.config().then((c) => { remote = c.security?.remote_content ?? true; }).catch(() => { remote = true; });
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
</SettingsPage>

<style>
  .item { display: flex; flex-direction: column; gap: var(--sp-5); }
  .name { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  .choice { display: flex; align-items: center; gap: var(--sp-3); font: var(--type-body); color: var(--text); cursor: pointer; }
  .note { margin: 0; max-width: 520px; font: var(--type-body); color: var(--text-faint); }
  .switch { flex: none; position: relative; width: 34px; height: 20px; border: 1px solid var(--rule); border-radius: 999px; background: var(--surface); cursor: pointer; padding: 2px; }
  .switch.on { background: var(--text-strong); border-color: var(--text-strong); }
  .switch:disabled { cursor: default; opacity: .6; }
  .knob { display: block; width: 14px; height: 14px; border-radius: 50%; background: var(--text-muted); transition: transform var(--dur-fast) var(--ease); }
  .switch.on .knob { transform: translateX(14px); background: var(--bg); }
</style>
