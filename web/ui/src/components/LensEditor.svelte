<script lang="ts">
  // Edit a lens (docs/plans/lenses-and-servers.md, 1e). A lens is exact: the
  // table shows what the rule takes now against what the lens had, before
  // anything is saved, and hand edits override the rule note by note. Who
  // can read the lens changes only here or on a server's page, each change
  // confirmed by typing the lens's name.
  import { onDestroy, onMount } from "svelte";
  import SettingsPage from "./SettingsPage.svelte";
  import InclusionRuleEditor from "./InclusionRuleEditor.svelte";
  import ConfirmByName from "./ConfirmByName.svelte";
  import RuleText from "./RuleText.svelte";
  import { app, gotoLens, gotoNote } from "../lib/store.svelte";
  import LensWarning from "./LensWarning.svelte";
  import { lensDraft, lensOpening, lensRequest, shareWords, type LensDetail, type LensNoteRow, type Preview, type PreviewRow, type ServerRef } from "../lib/lenses.svelte";

  let { id }: { id: string } = $props();
  const PAGE = 10;
  let lensId = $state(""), detail = $state<LensDetail | null>(null), servers = $state<ServerRef[]>([]);
  let name = $state(""), text = $state(""), ruleOpen = $state(false);
  let pins = $state<string[]>([]), exclusions = $state<string[]>([]);
  let preview = $state<Preview | null>(null), extra = $state<PreviewRow[]>([]);
  let tab = $state<"in" | "join" | "leave" | "removed">("in"), query = $state(""), showAll = $state(false);
  let problem = $state(""), busy = $state(false), disposed = false;
  let adding = $state(false), addQuery = $state(""), found = $state<LensNoteRow[]>([]);
  let asking = $state<{ server: ServerRef; on: boolean } | null>(null), confirmSave = $state(false), confirmDelete = $state(false), changesOpen = $state(false), dialogError = $state("");

  const saved = $derived(!!detail);
  const sharedWith = $derived(detail?.servers ?? []);
  const names = (list: ServerRef[]) => list.map((s) => s.name).join(", ");

  // ── loading and previewing ─────────────────────────────────────────────
  async function load() {
    const [all, lens] = await Promise.all([
      lensRequest<{ servers: ServerRef[] }>(""),
      id === "new" ? Promise.resolve(null) : lensRequest<LensDetail>("lens?id=" + encodeURIComponent(id)),
    ]);
    servers = all.servers;
    if (lens) {
      detail = lens; lensId = lens.id; name = lens.name; text = lens.text; pins = [...lens.pins]; exclusions = [...lens.exclusions]; void startPreview();
      if (lens.review && lensOpening.panel === "changes") changesOpen = true;
      if (lensOpening.panel === "rule") ruleOpen = true;
    }
    else { lensId = (await lensRequest<{ id: string }>("new", {})).id; text = lensDraft.text; lensDraft.text = ""; ruleOpen = true; }
    lensOpening.panel = "";
  }
  let generation = 0;
  async function startPreview() {
    if (!text.trim()) return;
    const g = ++generation; problem = "";
    try {
      let p = await lensRequest<Preview>("preview", { id: lensId, text });
      preview = p;
      while (p.busy && !disposed && g === generation) {
        await new Promise((r) => setTimeout(r, 700));
        if (disposed || g !== generation) return;
        p = await lensRequest<Preview>("preview?id=" + encodeURIComponent(p.id));
        if (g === generation) preview = p;
      }
    } catch (e) { if (g === generation) problem = (e as Error).message; }
  }
  onMount(() => { void load().catch((e) => { problem = e.message; }); });
  onDestroy(() => { disposed = true; generation++; });

  // ── the table ──────────────────────────────────────────────────────────
  // Until a preview lands, the lens as saved.
  const settled = $derived(preview && !preview.busy ? preview.rows : (detail?.notes ?? []).map((n): PreviewRow => ({ ...n, rule: !detail!.pins.includes(n.id), was: true, summarized: detail!.summarized.includes(n.id), failed: false })));
  const rows = $derived.by(() => {
    const byId = new Map<string, PreviewRow>();
    for (const r of [...settled, ...extra]) if (!byId.has(r.id)) byId.set(r.id, r);
    return [...byId.values()];
  });
  const pinned = $derived(new Set(pins)), removed = $derived(new Set(exclusions));
  const inside = (r: PreviewRow) => !removed.has(r.id) && (pinned.has(r.id) || r.rule);
  const lists = $derived({
    in: rows.filter(inside).sort((a, b) => Number(b.was) - Number(a.was) || b.date.localeCompare(a.date)),
    join: rows.filter((r) => inside(r) && !r.was),
    leave: rows.filter((r) => r.was && !inside(r)),
    removed: rows.filter((r) => removed.has(r.id)),
  });
  const why = (r: PreviewRow) =>
    removed.has(r.id) ? "Removed by you"
    : pinned.has(r.id) && !r.rule ? (r.was ? "Kept by you" : "Added by you")
    : r.was && !inside(r) ? "Rule no longer matches"
    : "Rule";
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase(), list = lists[tab].filter((r) => !q || r.title.toLowerCase().includes(q));
    return q || showAll ? list : list.slice(0, PAGE);
  });
  const without = (list: string[], x: string) => list.filter((y) => y !== x);
  function remove(r: PreviewRow) { if (pinned.has(r.id) && !r.rule) pins = without(pins, r.id); else { exclusions = [...exclusions, r.id]; pins = without(pins, r.id); } }
  function putBack(r: PreviewRow) { exclusions = without(exclusions, r.id); if (!r.rule && !pinned.has(r.id)) pins = [...pins, r.id]; }
  function keep(r: PreviewRow) { exclusions = without(exclusions, r.id); pins = [...new Set([...pins, r.id])]; }
  const act = (r: PreviewRow) => tab === "leave" ? { label: "Keep", run: () => keep(r) } : tab === "removed" ? { label: "Put back", run: () => putBack(r) } : { label: "Remove", run: () => remove(r) };

  // ── adding by hand ─────────────────────────────────────────────────────
  let findTimer: ReturnType<typeof setTimeout> | undefined;
  function find(q: string) {
    addQuery = q; clearTimeout(findTimer);
    findTimer = setTimeout(() => void lensRequest<{ items: LensNoteRow[] }>("notes?q=" + encodeURIComponent(q)).then((r) => { if (addQuery === q) found = r.items; }).catch(() => {}), 150);
  }
  function add(n: LensNoteRow) {
    const known = rows.find((r) => r.id === n.id);
    if (!known) extra = [...extra, { ...n, rule: false, was: false, summarized: false, failed: false }];
    if (!known?.rule || removed.has(n.id)) pins = [...new Set([...pins, n.id])];
    exclusions = without(exclusions, n.id);
    adding = false; addQuery = ""; found = [];
  }

  // ── saving, sharing, reviewing ─────────────────────────────────────────
  const canSave = $derived(!!name.trim() && !!text.trim() && !ruleOpen && !!preview && !preview.busy && !preview.error && !busy);
  async function save(confirm?: string) {
    busy = true; dialogError = "";
    try {
      const lens = await lensRequest<LensDetail>("save", { id: lensId, name, text, pins, exclusions, preview: preview!.id, confirm });
      confirmSave = false;
      if (!detail) { gotoLens(lens.id); return; }
      detail = lens; pins = [...lens.pins]; exclusions = [...lens.exclusions]; extra = []; app.rev++; void startPreview();
    } catch (e) { if (confirmSave) dialogError = (e as Error).message; else problem = (e as Error).message; }
    finally { busy = false; }
  }
  async function share(confirm: string) {
    if (!asking) return;
    busy = true; dialogError = "";
    try { detail = await lensRequest<LensDetail>("share", { id: lensId, server: asking.server.id, on: asking.on, confirm }); asking = null; app.rev++; }
    catch (e) { dialogError = (e as Error).message; }
    finally { busy = false; }
  }
  async function looksOk() {
    busy = true;
    try { detail = await lensRequest<LensDetail>("review-ok", { id: lensId }); changesOpen = false; app.rev++; }
    catch (e) { problem = (e as Error).message; }
    finally { busy = false; }
  }
  async function deleteLens(confirm: string) {
    busy = true; dialogError = "";
    try { await lensRequest("delete", { id: lensId, confirm }); app.rev++; gotoLens(null); }
    catch (e) { dialogError = (e as Error).message; }
    finally { busy = false; }
  }
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  function openDialog(d: HTMLDialogElement) { d.showModal(); }
</script>

<SettingsPage active="lenses" title={((detail?.name ?? name) || "New lens").toUpperCase()} count={sharedWith.length ? `Shared with ${names(sharedWith)}` : saved ? "Just you" : undefined} notice={problem ? { ok: false, text: problem } : null}>
  <div class="lens">
    <button class="back" onclick={() => gotoLens(null)}>← Lenses</button>

    {#if detail?.review}
      <LensWarning review={detail.review} servers={sharedWith} {busy} onchanges={() => (changesOpen = true)} onedit={() => (ruleOpen = true)} onok={looksOk} />
    {/if}

    <label class="field">Name<input bind:value={name} autocomplete="off" placeholder="Name this lens" /></label>

    <div class="field">
      <span>Rule</span>
      {#if ruleOpen && lensId}
        <InclusionRuleEditor target={{ kind: "lens", id: lensId }} value={text} onsave={(t) => { text = t; ruleOpen = false; void startPreview(); }} oncancel={saved ? () => (ruleOpen = false) : undefined} />
      {:else}
        <div class="rule"><p><RuleText {text} /></p><button class="text-button" onclick={() => (ruleOpen = true)}>Edit rule</button></div>
      {/if}
    </div>

    <div class="field">
      <span>Shared with</span>
      <div class="chips">
        {#each servers as s (s.id)}
          {@const on = sharedWith.some((x) => x.id === s.id)}
          <button class="chip" class:on aria-pressed={on} disabled={!saved || busy} onclick={() => { dialogError = ""; asking = { server: s, on: !on }; }}>{on ? "✓" : "+"} {s.name}</button>
        {/each}
      </div>
    </div>

    <section class="notes" aria-label="In this lens">
      <div class="notes-head">
        <h2>Yours in this lens</h2>
        {#if preview?.busy}<small role="status">Checking {preview.done.toLocaleString()} of {preview.total.toLocaleString()} notes…</small>
        {:else if preview && !preview.error}<small>{[plural(lists.in.length, "note", "notes"), ...(lists.join.length || lists.leave.length ? [`${lists.join.length} join`, `${lists.leave.length} leave`] : []), ...(preview.failed ? [`${plural(preview.failed, "note", "notes")} could not be checked`] : [])].join(" · ")}</small>{/if}
        <button class="settings-add add" disabled={!lensId} onclick={() => { adding = true; find(""); }}>Add +</button>
      </div>
      <div class="filter" role="tablist" aria-label="Filter">
        <button role="tab" aria-selected={tab === "in"} onclick={() => { tab = "in"; showAll = false; }}>Everything <small>{lists.in.length}</small></button>
        <button role="tab" aria-selected={tab === "join"} onclick={() => { tab = "join"; showAll = false; }}>Joining <small>{lists.join.length}</small></button>
        <button role="tab" aria-selected={tab === "leave"} onclick={() => { tab = "leave"; showAll = false; }}>Leaving <small>{lists.leave.length}</small></button>
        {#if lists.removed.length}<button role="tab" aria-selected={tab === "removed"} onclick={() => { tab = "removed"; showAll = false; }}>Removed by you <small>{lists.removed.length}</small></button>{/if}
      </div>
      <input class="search" type="search" aria-label="Search this lens" placeholder="Search this lens" autocomplete="off" bind:value={query} />
      <div class="table">
        {#each shown as r (r.id)}
          {@const a = act(r)}
          <div class="row">
            <button class="title" onclick={() => gotoNote(r.path)}>{r.title}</button>
            <span class="why">{[why(r), ...(r.summarized ? ["Summary"] : [])].join(" · ")}{#if inside(r) && !r.was}&nbsp;<b>Joins</b>{/if}</span>
            <span>{r.date}</span>
            <button class="text-button" aria-label={`${a.label}: ${r.title}`} onclick={a.run}>{a.label}</button>
          </div>
        {:else}<div class="empty"><small>{query ? "Nothing matches." : preview?.busy ? "" : "Nothing here."}</small></div>{/each}
      </div>
      {#if !query && !showAll && lists[tab].length > PAGE}<button class="settings-add" onclick={() => (showAll = true)}>Show all {lists[tab].length}</button>{/if}
    </section>

    <div class="save">
      {#if saved}<button class="text-button" disabled={busy} onclick={() => { dialogError = ""; confirmDelete = true; }}>Delete lens</button>{/if}
      <button class="primary" disabled={!canSave} onclick={() => { dialogError = ""; if (sharedWith.length) confirmSave = true; else void save(); }}>Save rule</button>
    </div>
  </div>
</SettingsPage>

{#if adding}
  <dialog class="picker" use:openDialog onclose={() => { adding = false; }} aria-label={`Add a note to ${name || "this lens"}`}>
    <div class="picker-head"><input type="search" aria-label="Search your vault" placeholder="Search your vault" autocomplete="off" value={addQuery} oninput={(e) => find(e.currentTarget.value)} /><button aria-label="Close" onclick={(e) => e.currentTarget.closest("dialog")?.close()}>×</button></div>
    <ul>
      {#each found as n (n.id)}
        {@const there = rows.some((r) => r.id === n.id && inside(r))}
        <li><button disabled={there} onclick={() => add(n)}><span>{n.title}</span><small>{there ? "In this lens" : n.date}</small></button></li>
      {:else}<li class="none"><small>{addQuery ? "Nothing matches." : ""}</small></li>{/each}
    </ul>
  </dialog>
{/if}

{#snippet changeList(label: string, list: LensNoteRow[])}
  {#if list.length}<h3>{label} <small>{list.length}</small></h3>
    <ul>{#each list as n (n.id)}<li><button onclick={() => gotoNote(n.path)}><span>{n.title}</span><small>{n.date}</small></button></li>{/each}</ul>{/if}
{/snippet}

{#if changesOpen && detail?.review}
  <dialog class="changes" use:openDialog onclose={() => (changesOpen = false)} aria-label="What changed">
    <div class="picker-head"><h2>What changed</h2><button aria-label="Close" onclick={(e) => e.currentTarget.closest("dialog")?.close()}>×</button></div>
    {@render changeList("Joining", detail.review.joins)}
    {@render changeList("Leaving", detail.review.leaves)}
  </dialog>
{/if}

{#if asking}
  {@const words = shareWords(name, asking.server.name, asking.on)}
  <ConfirmByName title={words.title} {name} action={words.action} {busy} error={dialogError} onconfirm={share} oncancel={() => (asking = null)}>{words.body}</ConfirmByName>
{/if}

{#if confirmSave}
  <ConfirmByName {name} action="Proceed" {busy} error={dialogError} onconfirm={(typed) => save(typed)} oncancel={() => (confirmSave = false)}>
    Every member of {names(sharedWith)} will be able to read every item in this lens. <strong>Check the items you’re sharing.</strong> Proceed?
  </ConfirmByName>
{/if}

{#if confirmDelete}
  <ConfirmByName title={`Delete ${name}?`} {name} action="Delete lens" {busy} error={dialogError} onconfirm={deleteLens} oncancel={() => (confirmDelete = false)}>
    {sharedWith.length ? `Are you sure? This removes visibility of every item in this lens for every user of ${names(sharedWith)}.` : "Are you sure?"}
  </ConfirmByName>
{/if}

<style>
  .lens { display: grid; gap: var(--sp-6); max-width: 860px; min-width: 0; }
  .back { justify-self: start; border: 0; background: none; padding: 0; font: var(--type-meta); color: var(--text-muted); cursor: pointer; }
  .back:hover { color: var(--text-strong); }
  .field { display: grid; gap: 10px; font: var(--type-meta); color: var(--text-muted); min-width: 0; }
  .field input { appearance: none; box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--rule); border-radius: 0; padding: 12px 14px; background: var(--well); color: var(--text-strong); font: var(--type-body); }
  .field input:focus-visible, .search:focus-visible, .picker-head input:focus-visible { outline: 1px solid var(--text-muted); outline-offset: 3px; }
  .rule { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 18px 20px; border: 1px solid var(--rule); }
  .rule p { margin: 0; font: var(--type-body); line-height: 1.6; color: var(--text-strong); }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { font: var(--type-body); padding: 8px 14px; border: 1px solid var(--rule); background: none; color: var(--text-muted); cursor: pointer; }
  .chip.on { border-color: var(--text-strong); color: var(--text-strong); }
  .chip:disabled { opacity: .45; cursor: default; }
  .save { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 12px 24px; }
  .text-button { border: 0; background: none; padding: 0; font: var(--type-meta); color: var(--text); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
  .text-button:disabled { opacity: .45; cursor: default; }
  .primary { font: var(--type-body); padding: 10px 18px; border: 1px solid var(--text-strong); background: var(--text-strong); color: var(--bg); cursor: pointer; }
  .primary:disabled { opacity: .35; cursor: default; }
  .notes { display: grid; gap: var(--sp-4); min-width: 0; }
  .notes-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 24px; }
  .notes-head h2 { margin: 0; font: var(--type-heading); color: var(--text-strong); }
  .notes-head .add { margin-left: auto; }
  small { font: var(--type-meta); color: var(--text-muted); }
  .filter { display: flex; flex-wrap: wrap; gap: 8px 28px; border-bottom: 1px solid var(--rule); }
  .filter button { font: var(--type-body); background: none; border: 0; border-bottom: 2px solid transparent; padding: 0 0 12px; color: var(--text-muted); cursor: pointer; }
  .filter button[aria-selected="true"] { border-bottom-color: var(--text); color: var(--text); }
  .filter small { margin-left: 8px; }
  .search, .picker-head input { appearance: none; box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--rule); border-radius: 0; padding: 12px 14px; background: var(--well); color: var(--text-strong); font: var(--type-body); }
  .table { display: grid; min-width: 0; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 190px) 96px 72px; gap: 16px; align-items: baseline; padding: 12px 0; border-bottom: 1px solid var(--rule); }
  .row > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--type-meta); color: var(--text-note); }
  .why b { font-weight: 600; color: var(--text-strong); }
  .row .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; border: 0; padding: 0; background: none; cursor: pointer; font: var(--type-body); color: var(--text-strong); }
  .row .title:hover { text-decoration: underline; text-underline-offset: 3px; }
  .row .text-button { justify-self: end; }
  .empty { padding: 18px 0; }
  dialog { width: min(560px, calc(100vw - 32px)); max-height: 80vh; box-sizing: border-box; padding: 28px; border: 1px solid var(--rule); background: var(--bg); color: var(--text); }
  dialog::backdrop { background: #0005; }
  .picker-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .picker-head h2 { margin: 0; flex: 1; font: var(--type-heading); color: var(--text-strong); }
  .picker-head button { flex: none; border: 0; background: none; font-size: 24px; line-height: 1; padding: 0 6px; color: var(--text-muted); cursor: pointer; }
  dialog ul { list-style: none; margin: 0; padding: 0; }
  dialog li button { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; width: 100%; padding: 10px 4px; border: 0; border-bottom: 1px solid var(--rule); background: none; text-align: left; font: var(--type-body); color: var(--text-strong); cursor: pointer; }
  dialog li button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  dialog li button small { flex: none; }
  dialog li button:disabled { cursor: default; color: var(--text-muted); }
  dialog li.none { padding: 10px 4px; }
  dialog h3 { margin: 18px 0 6px; font: var(--type-body); color: var(--text-strong); }
  @media (max-width: 600px) {
    .row { grid-template-columns: minmax(0, 1fr) 72px; }
    .row > span { display: none; }
    .rule { flex-direction: column; }
  }
</style>
