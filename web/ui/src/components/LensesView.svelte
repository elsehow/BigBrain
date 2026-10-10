<script lang="ts">
  // Settings › lenses: every lens, and who it is shared with. Sharing itself
  // happens inside a lens (LensEditor) or on a server's page, never here.
  import SettingsPage from "./SettingsPage.svelte";
  import RuleText from "./RuleText.svelte";
  import LensWarning from "./LensWarning.svelte";
  import { app, gotoLens } from "../lib/store.svelte";
  import { lensOpening, lensRequest, type LensSummary } from "../lib/lenses.svelte";
  let lenses = $state<LensSummary[] | null>(null), problem = $state(""), busy = $state("");
  $effect(() => { app.rev; void lensRequest<{ lenses: LensSummary[] }>("").then((r) => { lenses = r.lenses; }).catch((e) => { problem = e.message; }); });
  const shared = $derived(lenses?.filter((l) => l.servers.length).length ?? 0);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  function open(id: string, panel: "changes" | "rule") { lensOpening.panel = panel; gotoLens(id); }
  async function looksOk(id: string) {
    busy = id;
    try { await lensRequest("review-ok", { id }); app.rev++; }
    catch (e) { problem = (e as Error).message; }
    finally { busy = ""; }
  }
</script>

<SettingsPage active="lenses" title="LENSES" count={lenses ? `${plural(lenses.length, "lens", "lenses")} · ${shared} shared` : undefined} notice={problem ? { ok: false, text: problem } : null}>
  <div class="head"><button class="settings-add" onclick={() => gotoLens("new")}>New lens +</button></div>
  {#each lenses ?? [] as lens (lens.id)}
    <section class="settings-card" aria-label={lens.name}>
      {#if lens.review}
        <LensWarning review={lens.review} servers={lens.servers} busy={busy === lens.id} onchanges={() => open(lens.id, "changes")} onedit={() => open(lens.id, "rule")} onok={() => looksOk(lens.id)} />
      {/if}
      <div class="settings-card-row">
        <div class="settings-card-main">
          <h2 class="settings-card-name">{lens.name}</h2>
          <p class="settings-card-about"><RuleText text={lens.text} /></p>
          <small>{plural(lens.members, "note", "notes")} · <span class:shared={lens.servers.length}>{lens.servers.length ? `Shared with ${lens.servers.map((s) => s.name).join(", ")}` : "Just you"}</span></small>
        </div>
        <button class="settings-add" aria-label={`Edit ${lens.name}`} onclick={() => gotoLens(lens.id)}>Edit</button>
      </div>
    </section>
  {/each}
</SettingsPage>

<style>
  .head { display: flex; justify-content: flex-end; padding-bottom: var(--sp-4); border-bottom: 1px solid var(--rule); }
  section { display: grid; gap: var(--sp-6); }
  small { font: var(--type-meta); color: var(--text-muted); }
  .shared { color: var(--text-strong); }
</style>
