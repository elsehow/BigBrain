<script lang="ts">
  // The base's first gate after the vault: until the engine answers, a quiet
  // line; through first run, its screens; then the view on the base
  // (Base.svelte).
  import type { Snippet } from "svelte";
  import FirstRun from "./FirstRun.svelte";
  import { connectClaude, declareName, joinServer, pickVault, setupDone, setupStatus, type SetupState } from "../lib/setup";
  import { reader } from "../lib/reader.svelte";
  import { telemetryState, type TelemetrySnapshot } from "../lib/telemetry";
  import { app } from "../lib/store.svelte";

  const { children }: { children: Snippet } = $props();

  // FIRST RUN (#575). The setup door answers /api/setup under the desktop
  // app. Vault, identity and provider setup precede the installation-local
  // sharing choice. Either sharing answer completes setup. No door (a headless host,
  // an older engine) ⇒ null ⇒ the app as it always was. While the screens
  // are up they re-check on a short clock — Claude Code gets installed in
  // a terminal, and the door hands the port to the engine after step 1 —
  // and a miss on that clock (the handover's gap) keeps the last answer
  // rather than flashing the app.
  // undefined = not answered yet (or not reachable): decide nothing, keep
  // what was last known. null = the engine said there is no door.
  let setup = $state<SetupState | null | undefined>(undefined);
  let sharing = $state<TelemetrySnapshot | null | undefined>(undefined);
  const telemetryPending = $derived(!!sharing?.configured && !sharing.decided);
  const firstRun = $derived(!!setup && !setupDone(setup));
  $effect(() => { reader.on = setup?.onboarding === "reader"; reader.named = !!setup?.identity; });
  const waiting = $derived(setup === undefined || (!!setup && sharing === undefined));
  let pickingVault = false, setupEpoch = 0;
  async function refreshSetup(): Promise<void> {
    if (pickingVault) return;
    const epoch = setupEpoch;
    try {
      const next = await setupStatus();
      if (pickingVault || epoch !== setupEpoch) return;
      // A status poll carries no verdict about the folder the user just tried.
      // Retain that actionable error until another choice or vault takes over.
      if (next && setup?.pick && next.vault?.path === setup.vault?.path && !next.pick) next.pick = setup.pick;
      setup = next;
      if (setup && sharing == null) {
        try { sharing = await telemetryState(); }
        catch { sharing = null; } // Unavailable diagnostics must not block setup.
      }
    } catch {
      /* the engine is not answering — a handover, a restart: keep the last answer, ask again */
    }
  }
  // On mount and on every live ping (a connect on the agents card changes
  // the answer, and the top bar's dot reads it); every 3 s while first run
  // or nothing has answered, since no ping comes from a door.
  $effect(() => { void app.rev; void refreshSetup(); });
  $effect(() => {
    const t = setInterval(() => {
      if (firstRun || waiting) void refreshSetup();
    }, 3000);
    return () => clearInterval(t);
  });
  // The door hands the port to the engine (or the engine restarts on the
  // new vault): a second of nobody answering. Wait for it before the
  // views re-read, or they read the gap.
  async function waitForEngine(): Promise<void> {
    for (let i = 0; i < 40; i++) {
      try {
        const s = await setupStatus();
        if (s) setup = s;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    app.rev++;
  }
  async function onPick(path: string): Promise<void> {
    pickingVault = true; setupEpoch++;
    if (setup) setup = { ...setup, pick: undefined };
    try {
      setup = await pickVault(path);
      if (setup?.pick) return;
    await waitForEngine();
    } catch (e) {
      if (setup) setup = { ...setup, pick: { path, problem: e instanceof Error ? e.message : String(e) } };
    } finally { pickingVault = false; }
  }
  /** Join a server from first run. Without a vault the door makes one and
   * hands the port to the engine, so wait for it as a pick does. */
  async function onJoin(invite: string): Promise<void> {
    pickingVault = true; setupEpoch++;
    try {
      setup = await joinServer(invite);
      await waitForEngine();
    } finally { pickingVault = false; }
  }
  async function onConsent(enabled: boolean): Promise<void> {
    const saved = await telemetryState({ enabled });
    if (!saved) throw new Error("Sharing preferences unavailable.");
    sharing = saved;
  }
  async function onConnect(): Promise<void> {
    setup = await connectClaude();
    app.rev++;
  }
  async function onName(name: string, email?: string): Promise<void> {
    setup = await declareName(name, email);
    app.rev++;
  }

</script>

{#if waiting}
  <!-- nothing has answered yet: not the app, not first run — say so quietly -->
  <p class="waiting">Waiting for the engine…</p>
{:else if firstRun && setup}
  <FirstRun {setup} {onPick} {onJoin} {onConnect} {onName} {telemetryPending} {onConsent} />
{:else}
  {@render children()}
{/if}

<style>
  .waiting { margin: 0; padding: 40vh var(--app-gutter) 0; text-align: center;
    font: var(--type-meta); color: var(--text-faint); }
</style>
