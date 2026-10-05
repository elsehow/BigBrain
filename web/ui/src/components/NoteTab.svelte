<script lang="ts">
  import BlockScrollbar from "./BlockScrollbar.svelte";
  import SharedAssertions from "./SharedAssertions.svelte";
  import { isSharedRecord, selectedWorkspace } from "../lib/vaultScope";
  import { inspectActions } from "../lib/actionHistory.svelte";
  import KeyboardModifier from "./KeyboardModifier.svelte";
  import { SIDEBAR_LAYOUT, type SidebarLayout } from "../lib/sidebarLayout";
  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);
  import HistoryNavigation from "./HistoryNavigation.svelte";
  import ListNavigationHint from "./ListNavigationHint.svelte";
  import { findNode } from "../../../../lib/graphIdentity";
  import { canonicalGraphView, changeGraphView } from "../../../../lib/graphView";
  import { getContext, tick, untrack } from "svelte";
  import { api, swr } from "../lib/api";
  import { cursor, kbdTakes } from "../lib/cursor.svelte";
  import { startChat } from "../lib/pilotChat.svelte";
  import { editable, isMac } from "../lib/dom";
  import { currentRow, navDelta, stepped, createListJump } from "../lib/listNav";
  import { md, sanitizeHtml } from "../lib/markdown";
  import { openExternal } from "../lib/native";
  import { isNotePath } from "../lib/noteRoute";
  import { stage } from "../lib/stage.svelte";
  import { searchOverlay } from "../lib/omnibox.svelte";
  import { commandKey } from "../lib/omnibox";
  import { openOrigin } from "../lib/origin";
  import { ensureAllNotes } from "../lib/search.svelte";
  import { app, gotoNote } from "../lib/store.svelte";
  import { liveResource } from "../lib/liveResource.svelte";
  import type { GraphData, ProjectedEntityView, SourceOrigin } from "../lib/types";
  import { titleOf } from "../lib/utils";
  import { isUserNote as matchesUserNote, isUserNode } from "../lib/userNote";
  import { contextConnections } from "../../../../lib/contextConnections";
  import type { NoteBriefing } from "../../../../lib/noteBriefing";
  import OriginChip from "./OriginChip.svelte";
  import { cachedNoteBriefing, readNoteBriefing } from "../lib/noteBriefing";
  import { isUnreadSelection, selectedReadSources, markSelectedSources, sourceAttention } from "../lib/sourceAttention.svelte";
  import { tooltip } from "../lib/tooltip";

  // One summary and ordered relationship list for every readable node.
  let { graph, identity = null, probe = $bindable(null), previewPath = null }: {
    /** the constellation: names an entity before its record lands */
    graph: GraphData | null;
    /** Hover reuses the real summary without changing navigation or selection. */
    previewPath?: string | null;
    identity?: { name: string; entity_id: string } | null;
    /** the link the cursor is on, as a node key for the graph to light
     * beside the open note (LinkGraph's `probe`) */
    probe?: string | null;
  } = $props();

  import { quietSidebar as edgeRows } from '../lib/graphPresentation';
  let noteViewport = $state<HTMLDivElement>();

  // Graph hover and workspace previews carry node IDs, while the note API
  // reads paths. Entities and source insertions have different IDs and paths.
  const notePath = $derived(previewPath
    ? graph?.nodes[findNode(graph.nodes, previewPath)]?.path ?? (isNotePath(previewPath) ? previewPath : null)
    : app.activeNote);

  const noteSelection = $derived(previewPath ? { selected: [previewPath], excluded: [] } : app.graphView);

  // Setup already carries trusted identity on older running engines, so
  // hot-loaded UI changes need not wait for new graph metadata to arrive.
  const userNote = $derived(graph?.userNote ?? (identity ? { ids: [identity.entity_id], names: [identity.name] } : undefined));
  const isUserNote = (target: string): boolean => matchesUserNote(target, userNote);

  // The note's own date, from the note route itself (#639).
  let modified = $state<number | null>(null);
  let content = $state("");
  let projectedEntity = $state<ProjectedEntityView | null>(null);
  let sourceRecord = $state(false);
  let threadMessages = $state<Array<{ path: string; title: string; from?: string; at?: string }>>([]);
  // where a source lives outside the vault — the OPEN chip's target
  let origin = $state<SourceOrigin | null>(null);
  let loaded = $state(false);

  function clearNote(): void {
    content = ""; projectedEntity = null; sourceRecord = false;
    threadMessages = []; origin = null; modified = null;
  }
  liveResource(() => notePath,
    path => swr.note(path, path.startsWith("projection/entities/") ? 1 : undefined),
    r => {
      content = r.content;
      projectedEntity = r.projectedEntity ?? null;
      sourceRecord = r.sourceAssertions !== undefined;
      threadMessages = r.sourceThread?.messages ?? [];
      origin = r.origin ?? null;
      // Virtual notes have no file mtime; use the newest returned assertion.
      const dates = (r.projectedEntity?.assertions ?? r.sourceAssertions ?? []).map(a => Date.parse(a.created_at)).filter(Number.isFinite);
      modified = r.modified ?? (dates.length ? Math.max(...dates) : null);
      loaded = true;
    }, {
      onReset: () => { clearNote(); openFailed = false; loaded = false; },
      onError: (_error, hasValue) => { if (!hasValue) { clearNote(); loaded = true; } },
    });

  const readFeedback = $derived(!!sourceAttention.feedbackSelection && sourceAttention.feedbackSelection === JSON.stringify([...noteSelection.selected].sort()));
  const readSources = $derived(selectedReadSources(graph));
  const multiple = $derived(noteSelection.selected.length > 1);
  const selectedTitles = $derived(noteSelection.selected.map(id => graph?.nodes[findNode(graph.nodes, id)]?.title ?? titleOf(id.split("/").at(-1) ?? id)));
  const briefingRequest = $derived(JSON.stringify({ ...canonicalGraphView(graph?.nodes ?? [], { selected: noteSelection.selected.length ? noteSelection.selected : notePath ? [notePath] : [], excluded: noteSelection.excluded }), ...(!previewPath && isUnreadSelection() ? { purpose: "unread" } : {}) }));
  let briefing = $state<NoteBriefing | null>(null);
  let briefingError = $state("");
  let briefingPreview = $state("");
  let briefingLoading = $state(false);
  let briefingAttempt = $state(0);
  let briefingFor = "";
  // Briefings read this vault's own graph, which a shared vault's records
  // are not part of: those open on their text instead.
  const sharedRecord = $derived([notePath ?? "", ...noteSelection.selected].some(isSharedRecord));
  $effect(() => {
    if (selectedWorkspace) return;
    const path = sharedRecord ? null : notePath;
    const request = briefingRequest;
    void app.rev; void briefingAttempt;
    const controller = new AbortController();
    const selection = JSON.parse(request);
    const cached = path ? cachedNoteBriefing(selection) : undefined;
    // A selection owns its displayed content. Refresh/retry starts another
    // request, without rolling back the summary or moving the link cursor.
    if (briefingFor !== request || !path) {
      briefingFor = request;
      briefing = cached ?? null; briefingPreview = "";
      linkSel = -1; linkHover = -1; probe = null;
    } else if (cached) briefing = cached;
    briefingError = ""; briefingLoading = !!path && !cached;
    const hasSummary = untrack(() => !!(briefing?.summary || briefingPreview));
    // Cached summaries and descriptions paint synchronously above.
    // Debounce only fresh work, keeping that view visible during revalidation.
    const timer = path ? setTimeout(() => {
      void readNoteBriefing(selection, text => { if (!controller.signal.aborted && !hasSummary) briefingPreview = text; }, controller.signal)
        .then(result => {
          if (!controller.signal.aborted) {
            const currentPath = links()[linkSel]?.key;
            briefing = result;
            linkSel = currentPath ? connectionLinks.findIndex(l => l.path === currentPath) : -1;
            linkHover = -1;
          }
        })
        .catch(error => { if (!controller.signal.aborted) { briefingError = error.message; } })
        .finally(() => { if (!controller.signal.aborted) briefingLoading = false; });
    }, 150) : undefined;
    return () => { clearTimeout(timer); controller.abort(); };
  });
  // The shared context ranking paints immediately. The server returns that
  // same order with all selected memory bodies and validated descriptions.
  const rankedLinks = $derived<NoteBriefing["links"] | null>(graph && notePath
    ? contextConnections(graph, noteSelection.selected.length ? noteSelection.selected : [notePath], noteSelection.excluded, { [notePath]: content })
      .flatMap(({ node }) => node.path ? [{ id: node.id, path: node.path, title: node.title, evidence: [] }] : [])
    : null);
  const connectionLinks = $derived.by<NoteBriefing["links"]>(() => {
    const described = new Map(briefing?.links.map(link => [link.id, link]));
    return (briefing?.links ?? rankedLinks ?? []).filter(link => !isUserNode(link, userNote)).map(link => ({
      ...link, description: described.get(link.id)?.description, evidence: described.get(link.id)?.evidence ?? [],
    }));
  });
  const activeGraphNode = $derived(graph?.nodes[findNode(graph.nodes, notePath ?? "")] ?? null);
  // The graph names virtual records too: a running session may have no
  // readable note yet. Use the same resolved identity as its connections.
  const isOverview = $derived(!!sidebar && /(^|\/)MEMORY\.md$/.test(notePath ?? ""));
  const graphLabel = $derived(activeGraphNode?.title ?? null);

  // ── wikilinks: [[target]] / [[target|label]] → clickable in-vault navigation.
  // The whole result is run through sanitizeHtml() at the end (#552), so a
  // hostile label ("<img onerror>") is defanged like any other node; the
  // data-attribute's quotes are still escaped here so the string is well-formed
  // before it reaches the sanitizer. The label may carry single brackets
  // ("[PLDI'26] Compiling…" — clipped titles are labels); only `]]` closes, so a
  // lone `]` never swallows a following link. Mirrors lib/links.ts.
  function renderBody(body: string): string {
    return sanitizeHtml(
      md(body).replace(/\[\[([^\]|]+)(?:\|((?:[^\]]|\](?!\]))+))?\]\]/g, (_m, target: string, label?: string) => {
        const t = target.trim();
        // a citation of the record (memory's `[[ast_…]]`, or a joined shared
        // vault's `[[shared:<vault>:ast_…]]`): a mark, not a link — there is
        // no note behind an assertion id to open
        if (/^(?:shared:[A-Za-z0-9-]+:)?ast_[a-f0-9]+$/.test(t)) return `<sup class="cite">°</sup>`;
        const lbl = (label ?? target).trim();
        if (isUserNote(t)) return lbl;
        return `<a class="wl" role="link" tabindex="0" data-note="${t.replace(/"/g, "&quot;")}">${lbl}</a>`;
      // a run of citations is one mark: three ids behind a claim are still
      // one "the record says so"
      }).replace(/(<sup class="cite">°<\/sup>)(?:\s*<sup class="cite">°<\/sup>)+/g, "$1"),
    );
  }
  const norm = (s: string) => s.toLowerCase().replace(/\.md$/, "").replace(/[^a-z0-9]+/g, " ").trim();
  // Two link dialects resolve here. The CANONICAL one is root-relative —
  // `[[entities/alex-rowan|Alex Rowan]]` — what the runner's
  // canonicalizer rewrites every machine-written link to, so it must match
  // on PATH. The legacy bare dialect (`[[alex-rowan]]`) still falls back
  // to name/title matching. A slashed target that misses the index is
  // navigated as the path it already is.
  async function openWikilink(target: string) {
    // A bare native entity id — `[[ent_…|label]]` — is path-addressable by
    // construction; the legacy index below cannot name it (#501).
    const bare = target.trim();
    if (isUserNote(bare)) return;
    if (/^ent_[a-f0-9]{20}$/.test(bare)) return gotoNote(`projection/entities/${bare}.md`);
    const idx = await ensureAllNotes();
    const t = norm(target);
    const hit = idx.find((x) => norm(x.note.path) === t)
      ?? idx.find((x) => norm(titleOf(x.note.name)) === t || norm(x.note.name) === t)
      ?? idx.find((x) => norm(x.note.name).startsWith(t) || norm(titleOf(x.note.name)).startsWith(t))
      ?? idx.find((x) => norm(x.note.name).includes(t));
    if (hit) { if (!isUserNote(hit.note.path)) gotoNote(hit.note.path); return; }
    // Label dialect on a native vault: the index lists only the legacy
    // collections, but the graph names every projected entity with its
    // title and path (#501).
    const g = graph?.nodes.find((n) =>
      n.path?.startsWith("projection/entities/") && (norm(n.title) === t || norm(n.title).startsWith(t)));
    if (g?.path) { if (!isUserNote(g.path)) gotoNote(g.path); return; }
    if (target.includes("/")) gotoNote(isNotePath(target) ? target : `${target}.md`);
  }
  function onBodyActivate(e: Event) {
    const a = (e.target as HTMLElement)?.closest?.("a.wl") as HTMLElement | null;
    if (!a) return;
    if (e instanceof KeyboardEvent && e.key !== "Enter") return;
    e.preventDefault();
    openWikilink(a.dataset.note ?? "");
  }
  function wikilinks(node: HTMLElement) {
    node.addEventListener("click", onBodyActivate);
    node.addEventListener("keydown", onBodyActivate);
    return { destroy() { node.removeEventListener("click", onBodyActivate); node.removeEventListener("keydown", onBodyActivate); } };
  }

  // A legacy note's title and kind come off its frontmatter — `title:`,
  // else the body's leading H1 (an entity dossier's canonical name IS the
  // heading; the filename slug is a last resort). The body itself is not
  // rendered.
  const parsed = $derived.by(() => {
    const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
    const t = m?.[1].match(/^title:\s*(.+)$/m);
    const kind = m?.[1].match(/^(?:kind|type):\s*(.+)$/m)?.[1].trim() ?? "";
    const entityType = m?.[1].match(/^entity_type:\s*(.+)$/m)?.[1].trim() ?? "";
    const body = m ? content.slice(m[0].length) : content;
    const h1 = body.match(/^\s*#\s+(.+)\n+/);
    const title = t ? t[1].trim().replace(/^["']|["']$/g, "") : (h1?.[1]?.trim() ?? null);
    // the body past the heading that became the title
    return { title, kind, entityType, body: h1 ? body.slice(h1[0].length) : body };
  });

  // Keep original Markdown available below the generated reading aid.
  const body = $derived(loaded && (selectedWorkspace || !projectedEntity) ? unwrap(parsed.body.trim()) : "");
  /** memory is hard-wrapped at eighty columns (written for a terminal); a
   * paragraph's line breaks are not breaks here — a newline into anything
   * but a blank line or a block's first character joins with a space */
  function unwrap(text: string): string {
    return text.replace(/([^\n])\n(?![\n\s#>*\-|]|\d+\.)/g, "$1 ");
  }

  const title = $derived(multiple ? selectedTitles.join(" · ") : isOverview ? "Overview" : parsed.title ?? graphLabel ?? titleOf(notePath?.split("/").pop() ?? ""));
  $effect(() => {
    if (!previewPath && app.noteTab?.path === notePath) app.noteTab!.title = title;
  });
  // the rail's accessible name
  const railLabel = $derived(`Links connected to ${title}`);

  async function discuss() {
    if (!notePath || multiple) return;
    await startChat([notePath]);
  }
  // The button and Shift+Enter open a Pilot grounded in this note.
  function discussKey(e: KeyboardEvent) {
    if (e.defaultPrevented || multiple || e.key !== "Enter" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    if (app.view !== "vault" || !notePath || editable(e.target)) return;
    e.preventDefault();
    void discuss();
  }

  // OPEN — the source's origin: the page it was clipped
  // from in the browser, a dropped file's original in whatever the OS
  // reads it with, or a Markdown copy of a text-only drop. Which opener takes which is lib/origin.ts's switch; the
  // chip (OriginChip) and ⌘O both land here. A refusal — the engine could
  // not open it — flips the chip's label for a moment rather than raising
  // a dialog; the engine's log has the reason.
  let openFailed = $state(false);
  let failedTimer: ReturnType<typeof setTimeout> | undefined;
  async function openSource() {
    const p = notePath;
    if (!p || !origin || multiple) return;
    try {
      await openOrigin(origin, p, { external: openExternal, engine: api.openSource });
    } catch {
      openFailed = true;
      clearTimeout(failedTimer);
      failedTimer = setTimeout(() => { openFailed = false; }, 2500);
    }
  }
  // ⌘O (ctrl+O elsewhere) — the platform's own "open" — on a source that
  // has an origin; a note without one leaves the key to the browser
  const mac = isMac();
  function openKey(e: KeyboardEvent) {
    if (!commandKey(e, mac) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "o") return;
    if (app.view !== "vault" || multiple || !origin || editable(e.target)) return;
    e.preventDefault();
    void openSource();
  }

  // j/k follows selection-relative PageRank throughout generation. The current link probes the
  // graph without changing the selected note; Enter selects it.
  interface Link { key: string; els: HTMLElement[]; open: () => void }
  let rail = $state<HTMLElement | null>(null);
  let linkSel = $state(-1);
  let linkHover = $state(-1);
  const linkCurrent = $derived(currentRow(cursor.input, linkHover, linkSel));
  /** The rendered relationship list is the API array in exactly its order.
   * Original-note links remain clickable, outside the j/k walk. */
  function links(): Link[] {
    if (!rail) return [];
    const out: Link[] = [];
    for (const el of rail.querySelectorAll<HTMLElement>(".source-links button.rail-chip[data-path]")) {
      const path = el.dataset.path!;
      out.push({ key: path, els: [el], open: () => gotoNote(path) });
    }
    return out;
  }
  const linkAt = (el: Element | null): number => {
    const hit = el?.closest?.("button.rail-chip[data-path]");
    return hit ? links().findIndex((l) => l.els.includes(hit as HTMLElement)) : -1;
  };
  function onRailOver(e: PointerEvent): void { linkHover = linkAt(e.target as Element); }
  function onRailOut(e: PointerEvent): void {
    // leaving a link for anything that is not the same link
    const to = linkAt(e.relatedTarget as Element | null);
    if (to !== linkHover) linkHover = to;
  }
  const listJump = createListJump();
  function linkNav(e: KeyboardEvent) {
    if (e.defaultPrevented || app.view !== "vault" || editable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    // Native controls own Enter; j/k still moves the relationship cursor.
    if (e.key === "Enter" && (e.target as Element)?.closest("button, a, summary")) return;
    const all = links();
    const jump = listJump(e);
    if (jump) { e.preventDefault(); if (jump !== 'pending' && all.length) { kbdTakes(); linkSel = jump === 'first' ? 0 : all.length - 1; } return; }
    const d = navDelta(e);
    if (d) {
      if (!all.length) return;
      e.preventDefault();
      (e.target as HTMLElement)?.blur?.();
      kbdTakes(); // the keyboard owns the cursor — a link under a parked pointer does not paint
      linkSel = stepped(linkSel, d, all.length);
    } else if (e.key === "Enter" && !e.shiftKey && linkSel >= 0 && all[linkSel]) {
      e.preventDefault();
      kbdTakes();
      all[linkSel]!.open();
    }
  }
  // paint the current link (every element of it), keep it in view, and
  // hand the graph its node after changes to the connections or body settle.
  $effect(() => {
    void connectionLinks;
    const i = linkCurrent;
    void tick().then(() => {
      rail?.querySelectorAll(".lk-on").forEach((el) => el.classList.remove("lk-on"));
      const l = links()[i];
      l?.els.forEach((el) => el.classList.add("lk-on"));
      if (i === linkSel && cursor.input === "kbd") {
        if (sidebar && i === 0) rail?.closest(".note-scroll")?.scrollTo({ top: 0 });
        else l?.els[0]?.scrollIntoView({ block: "nearest" });
      }
      probe = l && l.key.includes("/") ? l.key : null;
    });
  });
  const summary = $derived(briefing?.summary ?? briefingPreview);
  const summaryTitle = $derived(!multiple && summary.startsWith(title) ? title : "");
  const updatedLabel = $derived(modified ? new Date(modified).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).replace(",", "") : "");
  function controlKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  }
  function addConnection(id: string) {
    const current = { selected: noteSelection.selected.length ? noteSelection.selected
      : notePath ? [notePath] : [], excluded: noteSelection.excluded };
    app.graphView = changeGraphView(graph ? canonicalGraphView(graph.nodes, current) : current, { type: "add", id });
  }
  function openConnection(e: MouseEvent, link: NoteBriefing["links"][number]) {
    if (!e.shiftKey) { gotoNote(link.path); return; }
    e.preventDefault();
    addConnection(link.id);
  }
  function toggleRead() {
    if (!notePath || !readSources.length || sourceAttention.saving) return;
    void markSelectedSources(graph, !readSources.some(r => r.readState.unread));
  }
  function noteKey(e: KeyboardEvent) {
    if (previewPath) return;
    if (searchOverlay.open || stage.pilotsOpen) return;
    if (!e.defaultPrevented && !e.isComposing && e.shiftKey && e.key.toLowerCase() === "u" && !e.metaKey && !e.ctrlKey && !e.altKey
      && !editable(e.target) && !(e.target instanceof HTMLSelectElement) && notePath && readSources.length) {
      e.preventDefault();
      if (!e.repeat) toggleRead();
      return;
    }
    linkNav(e);
    discussKey(e);
    openKey(e);
  }
  // Reveal full names only when ellipsis actually hides part of the title.
  function titleHint(node: HTMLElement, text: string) {
    let title = text;
    const hint = tooltip(node, undefined);
    const label = node.querySelector<HTMLElement>(".link-title")!;
    const sync = () => hint?.update?.(label.scrollWidth > label.clientWidth ? title : undefined);
    const observer = new ResizeObserver(sync);
    observer.observe(label);
    return { update(next: string) { title = next; sync(); }, destroy() { observer.disconnect(); hint?.destroy?.(); } };
  }
</script>

<svelte:window onkeydown={noteKey} />

{#if notePath}
  <header class="hud-header note-header">
    <HistoryNavigation />
    <div class="hud-identity">
      <h1 class="note-title" use:tooltip={title}>{title}</h1>
      {#if !multiple && modified}
        <time class="note-ts" datetime={new Date(modified).toISOString()}>Updated {updatedLabel}</time>
      {/if}
    </div>
    <div class="note-actions" aria-label="Note actions">
      {#if !multiple && origin}<OriginChip {origin} failed={openFailed} onclick={openSource} />{/if}
      {#if !multiple && !selectedWorkspace}<button class="pchip discuss-shortcut" onclick={discuss} onkeydown={controlKey} aria-keyshortcuts="Shift+Enter"><span>Discuss with Pilot</span><kbd aria-hidden="true"><KeyboardModifier name="shift" />↵</kbd></button>{/if}
    </div>
  </header>
  <div class="note-scroll" bind:this={noteViewport} id={previewPath ? undefined : "note-relationship-scroll"}>
    {#if sourceAttention.error && readFeedback}<p class="read-feedback" role="alert">{sourceAttention.error} <button onclick={() => inspectActions()}>Inspect actions</button></p>{/if}
    {#if sourceAttention.receipt && readFeedback}<p class="read-feedback" role="status">{sourceAttention.receipt}</p>{/if}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <section class="note-links" aria-label={railLabel} bind:this={rail}
      onpointerover={onRailOver} onpointerout={onRailOut}>
      <div class="briefing" aria-label="Note briefing" aria-busy={briefingLoading}>
        <div class="summary-column">
          <div class="source-actions note-shortcuts">      {#if readSources.length}
        <button disabled={sourceAttention.saving} onclick={toggleRead} aria-keyshortcuts="Shift+U" aria-label={sourceAttention.saving ? "SYNCING…" : readSources.some(r => r.readState.unread) ? "MARK READ" : "MARK UNREAD"}><kbd class="keyboard-hint" aria-hidden="true"><KeyboardModifier name="shift" />U</kbd> {sourceAttention.saving ? "SYNCING…" : readSources.some(r => r.readState.unread) ? "MARK READ" : "MARK UNREAD"}</button>
      {/if}
          </div>
          {#if summary}
            <p class="briefing-summary">{#if summaryTitle}<strong>{summaryTitle}</strong>{summary.slice(summaryTitle.length)}{:else}{summary}{/if}</p>
          {/if}
          {#if briefingError}
            <p class="briefing-error" class:with-summary={!!summary} role="status">{summary ? "Couldn’t finish the descriptions." : `No summary yet. ${briefingError}`} <button class="retry" onclick={() => briefingAttempt++}>Retry</button></p>
          {:else if briefingLoading && (!summary || briefingAttempt > 0)}
            <span class="briefing-spinner" class:with-summary={!!summary} role="status" aria-label={summary ? "Retrying descriptions" : "Generating summary and relationships"}></span>
          {/if}
          {#if !multiple && threadMessages.length}
            <div class="note-chips">
              {#if threadMessages.length}
                <details class="thread-messages">
                  <summary>{threadMessages.length} messages</summary>
                  <div class="message-list">
                    {#each threadMessages as message (message.path)}
                      <button onclick={() => gotoNote(message.path)} use:tooltip={message.title}><span>{message.from || message.title}</span><time>{message.at ? new Date(message.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</time></button>
                    {/each}
                  </div>
                </details>
              {/if}
            </div>
          {/if}
          {#if body && !multiple}
            <details class="original-note" class:shared-record={sharedRecord} open={!!selectedWorkspace || sharedRecord || (!!briefingError && !summary)}>
              <summary>Read note</summary>
              <div class="note-body body"><div class="body-cell">
                <div class="body-text md-body prose" use:wikilinks>{@html renderBody(body)}</div>
              </div></div>
            </details>
          {/if}
          {#if selectedWorkspace}<SharedAssertions path={notePath} />{/if}
        </div>
        <div class="source-links" aria-label="Connected records">
          {#each connectionLinks as link, i (link.id)}
            <button class="source-link rail-chip" class:remaining-start={!link.description && !!connectionLinks[i - 1]?.description}
              data-path={link.path} use:titleHint={link.title} onclick={(e) => openConnection(e, link)} onfocus={() => { linkSel = i; }}>
              <strong class="link-title">{link.title}</strong>
              {#if link.description}<span class="link-description">{link.description}</span>{/if}
            </button>
          {:else}{#if !briefingLoading}<p class="links-empty">No linked records yet.</p>{/if}{/each}
          {#if connectionLinks.length}<ListNavigationHint />{/if}
        </div>
      </div>
    </section>
  </div>
  {#if edgeRows && sidebar && !previewPath}<BlockScrollbar viewport={noteViewport} label="Scroll relationships" controls="note-relationship-scroll" />{/if}
{/if}

<style>
  .read-feedback { margin: 12px 20px; font: var(--type-meta); color: var(--text-muted); }
  .hud-header { display: flex; flex: none; align-items: center; justify-content: space-between; gap: 24px;
    padding: 14px 20px; border-bottom: 1px solid var(--rule);
    font: 500 10.5px/1.5 var(--font-mono); letter-spacing: .13em; text-transform: uppercase; }
  .hud-identity { display: flex; flex-direction: column; align-items: flex-start; width: 100%; min-width: 0; gap: 8px; }
  .note-title { font: 500 22px/1.25 var(--font-app); letter-spacing: -.02em; text-transform: none; color: var(--text-strong); margin: 0;
    min-width: 0; white-space: normal; overflow-wrap: anywhere; }
  .note-ts { color: var(--text-muted); font: 11px/1.5 var(--font-app); letter-spacing: 0; text-transform: none; font-variant-numeric: tabular-nums; }
  .note-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .note-actions kbd { color: var(--text-muted); }
  .note-actions button:focus-visible { outline: 1px solid var(--text-strong); outline-offset: 3px; }
  .note-shortcuts { display: flex; flex: none; align-items: center; gap: 18px; color: var(--text-muted); }
  .note-shortcuts button { display: inline-flex; align-items: center; gap: 6px; border: 0; padding: 0; background: transparent;
    color: inherit; cursor: pointer; font: inherit; letter-spacing: inherit; white-space: nowrap; }
  .note-shortcuts button:hover:not(:disabled) { color: var(--text-strong); }
  .note-shortcuts button:disabled { opacity: .45; cursor: default; }
  .note-shortcuts button:focus-visible { outline: 1px solid var(--text-strong); outline-offset: 4px; border-radius: 2px; }
  kbd { font: inherit; color: var(--text-strong); border: 0; padding: 0; background: none; }
  .hud-header { flex-wrap:wrap; }
  .source-actions:has(button) { margin-bottom:16px; }
  .source-links { --list-hint-inset:12px; }
  .note-scroll { flex: 1; min-height: 0; overflow: hidden; }
  .note-links { height: 100%; min-height: 0; }
  .briefing { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 48px;
    height: 100%; min-height: 0; padding: 22px 20px 24px; box-sizing: border-box;
    animation: content-arrive 140ms ease-out both; }
  .summary-column, .source-links { min-width: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
  .briefing-summary { margin: 0; font: var(--fw-regular) 20px/1.55 var(--font-app); color: var(--text); overflow-wrap: anywhere; }
  .briefing-summary strong { font-weight: 650; }
  .briefing-error { margin: 0; font: var(--type-meta); color: var(--text-muted); }
  .with-summary { margin-top: 12px; }
  .retry { border: 0; background: none; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }
  .briefing-spinner { display: block; width: 18px; height: 18px; border: 2px solid var(--rule); border-top-color: var(--text-muted); border-radius: 50%; animation: spin .8s linear infinite; }
  .source-links { margin: -10px -2px 0 -12px; padding-right: 2px; }
  .source-link { appearance: none; display: grid; grid-template-columns: minmax(100px, 29%) minmax(0, 1fr);
    gap: 18px; align-items: baseline; width: 100%; border: 0; border-radius: 8px; padding: 10px 12px;
    text-align: left; color: var(--text); background: transparent; cursor: pointer; white-space: normal; overflow-wrap: anywhere;
    font: var(--fw-regular) 18px/1.5 var(--font-app); }
  .link-title { color: inherit; font-weight: 650; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .link-description { color: inherit; animation: content-arrive 140ms ease-out both; }
  .source-link.remaining-start { margin-top: 12px; }
  .source-link:not(:has(.link-description)) { grid-template-columns: minmax(0, 1fr); }
  .note-chips { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-3); margin-top: 16px; }
  .thread-messages { font: var(--type-meta); color: var(--text-muted); }
  .thread-messages summary { cursor: pointer; }
  .message-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .message-list button { display: flex; gap: 12px; width: 100%; padding: 6px 0; border: 0;
    background: none; color: var(--text); text-align: left; cursor: pointer; font: inherit; }
  .message-list button:hover, .message-list button:focus-visible { background: var(--well); }
  .message-list button span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .message-list time { flex-shrink: 0; color: var(--text-muted); }
  .original-note { margin-top: 16px; }
  .original-note summary { color: var(--text-muted); font: var(--type-meta); cursor: pointer; margin-bottom: 12px; }
  .body-text { font: var(--fw-regular) 20px/1.55 var(--font-app); color: var(--text); overflow-wrap: anywhere; }
  .body-text :global(p) { margin: 0 0 12px; font: inherit; }
  .body-text :global(h2), .body-text :global(h3) { margin: 20px 0 8px; font: inherit; font-weight: 650; }
  .body-text :global(ul), .body-text :global(ol) { padding-left: 1.4em; font: inherit; }
  .body-text :global(sup.cite) { color: var(--text-faint); font-size: .7em; line-height: 0; }
  .links-empty { margin: 10px 12px; font: var(--type-meta); color: var(--text-muted); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes content-arrive { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: translateY(0); } }
  @container (max-width: 900px) {
    .hud-header { flex-wrap: wrap; gap: 8px; padding: 12px 20px; }
    .briefing { gap: 28px; }
    .source-link { grid-template-columns: minmax(80px, 32%) minmax(0, 1fr); gap: 12px; }
  }
  @container (max-width: 560px) {
    .hud-header { padding: 12px 16px; }
    .note-shortcuts { gap: 14px; font-size: 9px; letter-spacing: .08em; flex-wrap: wrap; }
    .note-scroll { overflow-y: auto; }
    .note-links { height: auto; }
    .briefing { grid-template-columns: minmax(0, 1fr); gap: 24px; padding: 18px 16px; height: auto; }
    .summary-column, .source-links { overflow: visible; }
    .source-link { grid-template-columns: minmax(80px, 32%) minmax(0, 1fr); }
  }
  @media (prefers-reduced-motion: reduce) { .briefing, .link-description, .briefing-spinner { animation: none; } }
</style>
