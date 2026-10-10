<script lang="ts">
  import ThemeView from "./ThemeView.svelte";
  import AgentAccessSettings from "./AgentAccessSettings.svelte";
  import DesktopNetworkSettings from "./DesktopNetworkSettings.svelte";
  import GraphSettingsView from "./GraphSettingsView.svelte";
  import ShortcutsView from "./ShortcutsView.svelte";
  import SharingSettings from "./SharingSettings.svelte";
  import SettingsPage from "./SettingsPage.svelte";
  import VaultPicker from "./VaultPicker.svelte";
  import { guardNotice, type Notice } from "../lib/notice";
  import { pickVault, setupStatus, shortPath, type SetupState } from "../lib/setup";
  import { app } from "../lib/store.svelte";

  // Settings → vault: where the notes live. The first thing first run asks
  // and the one setting everything else hangs off, so it heads the rail.
  // The card is the eyebrow line (VAULT, the path in use), a "Switch
  // vault" heading, and first run's own control (VaultPicker) — Create new
  // / Open — and nothing else (Nick, 2026-08-27): switching is the same act
  // as choosing, against a different folder, so it gets the same two rows
  // and no prose.
  //
  // Absent `/api/setup` (a headless host) the card still says where the
  // vault is — the engine knows — but offers no switch: on a box the vault
  // is chosen by BIGBRAIN_VAULT or the pointer file, and a button that
  // rewrote either from a browser would be a surprise.
  let setup = $state<SetupState | null>(null);
  let loaded = $state(false);
  let notice = $state<Notice | null>(null);

  async function load(): Promise<void> {
    try { setup = await setupStatus(); } catch { setup = null; }
    loaded = true;
  }
  $effect(() => { void app.rev; void load(); });

  async function onPick(path: string): Promise<void> {
    await guardNotice(
      (n) => (notice = n),
      async () => {
        setup = await pickVault(path);
        if (setup.vault && !setup.pick) notice = { ok: true, text: `now using ${shortPath(setup.vault.path)}` };
      }
    );
  }
</script>

<SettingsPage active="vaultSettings" title="GENERAL"
  value={setup?.vault ? shortPath(setup.vault.path) : undefined} {notice}>
  <div class="item">
    <!-- the path in use is the tabs line above; this names the act -->
    <span class="name">Switch vault</span>
    {#if !loaded}
      <p class="empty">Loading…</p>
    {:else if setup}
      <VaultPicker current={setup.vault} pick={setup.pick} {onPick} />
    {:else}
      <p class="empty">
        On a headless host the vault is chosen when the engine starts —
        <code>BIGBRAIN_VAULT</code>, the nearest <code>vault.yaml</code>, or
        <code>~/.config/bigbrain/vault</code> — and <code>bigbrain init --vault …</code>
        makes a new one.
      </p>
    {/if}
  </div>

  <ThemeView />

  <GraphSettingsView />

  <ShortcutsView />

  <AgentAccessSettings />

  <DesktopNetworkSettings />

  <SharingSettings />
</SettingsPage>

<style>
  .item { display: flex; flex-direction: column; gap: var(--sp-5); }
  .name { font: var(--type-heading); letter-spacing: var(--ls-heading); color: var(--text-strong); }
  .empty { font: var(--type-body); color: var(--text-faint); margin: 0; max-width: 520px; }
  code { font-family: var(--font-mono); }
</style>
