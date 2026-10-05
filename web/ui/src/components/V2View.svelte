<script lang="ts">
  // /v2 (its own page, v2.html) — the vault as a field, and the record
  // read as it lands, each assertion with its author. The canvas is
  // lib/v2/scene.ts (three.js, loaded on demand); everything with words
  // is here. Keys: / search by name, j/k walk the feed (Enter opens a row's
  // source), Shift+Enter starts a pilot on what's in hand ("Re: …"), ⌘N (or n) a blank
  // one the pilot names itself, \ shows or hides the desktop's views, Esc back out.
  // Pilots are the real agents: /api/pilot/chat sessions, placed over their
  // context, and their chat opens here as a flat column over the field.
  import { onMount, tick } from "svelte";
  import { api } from "../lib/api";
  import { workspaceURL } from "../lib/vaultScope";
  import type { GraphData } from "../lib/types";
  import { barPilots, buildField, latestPerFamily, neighbours, placePilots, searchNames, twinsOf, type Field, type PilotSummary, type V2Feed, type V2FeedRow } from "../lib/v2/model";
  import { md, sanitizeHtml } from "../lib/markdown";
  import { pageDoc, themeSheet, themeVars } from "../lib/pageTheme";
  import type { V2Scene } from "../lib/v2/scene";
  import { plainText as plain, type V2SortedRow } from "../../../../lib/v2Feed";
  import type { DesktopTile, DesktopView } from "../../../../lib/pilotDesktop";

  /** Where the app lives, for settings and pilot conversations: beside this
   * page in a build; a dev preview can point at the live engine instead
   * (VITE_V2_APP), since a read-only preview can't hold a conversation. */
  const APP: string = import.meta.env["VITE_V2_APP"] ?? "./";

  /** The workbench hands in fabricated data; the app fetches the vault's. */
  let { data = null }: { data?: { graph: GraphData; v2: V2Feed } | null } = $props();

  let host: HTMLDivElement;
  let hudEl: HTMLElement | undefined = $state();
  let feedEl: HTMLElement | undefined = $state();
  let searchEl: HTMLElement | undefined = $state();
  let qEl: HTMLInputElement | undefined = $state();
  let sidebarEl: HTMLElement | undefined = $state();
  /** The chat's width, when you've dragged the split (null: the default
   * clamp). Yours, not the agent's — remembered on this machine. */
  const GUTTER = 34;
  let chatWidth: number | null = $state(storedWidth());
  function storedWidth(): number | null {
    try { const w = Number(localStorage.getItem("v2.chatWidth")); return w > 0 ? w : null; } catch { return null; }
  }
  function rememberWidth(w: number | null): void {
    try { if (w) localStorage.setItem("v2.chatWidth", String(w)); else localStorage.removeItem("v2.chatWidth"); } catch { /* a per-viewer nicety only */ }
  }
  function dragSplit(e: PointerEvent): void {
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      chatWidth = Math.round(Math.min(innerWidth - 2 * GUTTER - 320, Math.max(380, m.clientX - 2 * GUTTER)));
      scene?.shift(shiftFor());
    };
    const up = () => { handle.removeEventListener("pointermove", move); rememberWidth(chatWidth); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
  }
  function resetSplit(): void {
    chatWidth = null; rememberWidth(null);
    scene?.shift(shiftFor());
  }
  let field: Field | null = $state(null);
  let writing: V2Feed | null = $state(null);
  let error = $state("");
  let scene: V2Scene | null = null;
  let twins = new Map<number, number[]>();

  let ent: number | null = $state(null);
  let entRows: V2FeedRow[] | null = $state(null);
  /** The sorted feed (lib/feedStage.ts), when the vault has one. */
  let sorted: V2SortedRow[] = $state([]);
  /** The feed row j/k has in hand (by source), and the source opened from it
   * with Quick's summary of it ("" while it is written). */
  let cursor: string | null = $state(null);
  let src: { row: V2SortedRow; text?: string } | null = $state(null);
  let searching = $state(false);
  let query = $state("");
  let matches: number[] = $state([]);
  let active = $state(0);
  let notice = $state("");

  // ── pilots ──────────────────────────────────────────────────────────────
  type PilotDetail = PilotSummary & { messages: Array<{ id: string; role: "user" | "assistant" | "activity"; text: string; at: string; ok?: boolean }>; error?: string; viewRevision?: number;
    desktop?: { views: DesktopView[]; layout: DesktopTile | null; arrangedBy: "agent" | "human" | null };
    /** Coding desktops: each fork's work, and the servers it runs. */
    changes?: Array<{ project: string; branch: string; commits: number; dirty: number; stat: string }>;
    servers?: Array<{ port: number; command?: string }> };
  /** Coding desktops (lib/codingDesktops.ts) have `d-` ids and live at /api/desktops;
   * Pilot conversations keep their own routes. One switch, so the rest of the view is shared. */
  const coding = (id: string | null | undefined): boolean => !!id && id.startsWith("d-");
  let pilotsAll: PilotSummary[] = $state([]);
  let openPilot: string | null = $state(null);
  let detail: PilotDetail | null = $state(null);
  let draftText = $state("");
  /** A desktop is the chat plus the views its agent chose to show beside it
   * (lib/pilotDesktop.ts): the engine holds them, so they survive reloads and
   * the agent sees what is open. With none (or hidden with \) the chat stands
   * alone, centred. You can close a view; the agent leaves it closed. */
  let hidden: Record<string, boolean> = $state({});
  let desktopViews: DesktopView[] = $derived.by(() => detail?.desktop?.views ?? []);
  let showDesktop = $derived(!!openPilot && desktopViews.length > 0 && !hidden[openPilot]);
  let notes: Record<string, { content?: string; error?: string }> = $state({});
  $effect(() => {
    for (const v of desktopViews) if (v.kind === "note" && !notes[v.path]) {
      notes[v.path] = {};
      api.note(v.path).then((r) => { notes[v.path] = { content: r.content.replace(/^---\n[\s\S]*?\n---\n/, "") }; })
        .catch((e) => { notes[v.path] = { error: errText(e) }; });
    }
  });
  async function closeView(view: string): Promise<void> {
    if (!openPilot) return;
    try {
      if (coding(openPilot)) await desktopReq("/view", { id: openPilot, action: "close", view });
      else await pilotReq("/desktop", { id: openPilot, action: "close", view });
      await loadDetail(); void tick().then(() => scene?.shift(shiftFor()));
    }
    catch (e) { flash(`Couldn’t close the view: ${errText(e)}`); }
  }

  // ── the agent a session talks to: its backend, changeable from the chat ──
  type AgentChoice = { id: string; label: string; ready: boolean; models: Array<{ id: string; label: string; reasoning?: string[] }> };
  let pickerOpen = $state(false);
  /** The picker leads with each family's newest model; the rest wait behind "Other". */
  let pickerAll = $state(false);
  let agentsList: AgentChoice[] = $state([]);
  // renaming by hand: the title is an input while you edit it; the name then stands
  let renaming = $state(false);
  let renameText = $state("");
  let renameEl: HTMLInputElement | undefined = $state();
  function startRename(): void {
    if (!detail) return;
    renameText = detail.title; renaming = true;
    void tick().then(() => { renameEl?.focus(); renameEl?.select(); });
  }
  async function saveRename(): Promise<void> {
    const id = openPilot, title = renameText.trim();
    renaming = false;
    if (!id || !title || title === detail?.title) return;
    try {
      // the engine's rename marks the name as a person's (Quick stops re-naming);
      // an older engine without it still takes the title through /context
      if (coding(id)) await desktopReq("/rename", { id, title });
      else {
        try { await pilotReq("/rename", { id, title }); }
        catch { await pilotReq("/context", { id, nodes: detail?.context ?? [], title, expectedRevision: detail?.viewRevision ?? 0 }); }
      }
      await loadDetail(); await refreshPilots();
    } catch (e) { flash(`Couldn’t rename: ${errText(e)}`); }
  }
  async function openPicker(): Promise<void> {
    pickerOpen = true; pickerAll = false;
    if (!agentsList.length) {
      try { agentsList = (await pilotReq<{ agents: AgentChoice[] }>("/models")).agents.filter((a) => a.ready); } catch (e) { flash(errText(e)); }
    }
  }
  async function chooseModel(agent: AgentChoice, model: { id: string; reasoning?: string[] }): Promise<void> {
    if (!openPilot) return;
    const [adapter, provider] = agent.id.split("/");
    const reasoning = model.reasoning?.includes("medium") ? "medium" : model.reasoning?.[0];
    try {
      if (coding(openPilot)) await desktopReq("/model", { id: openPilot, model: `${provider}/${model.id}` });
      else await pilotReq("/backend", { id: openPilot, backend: { adapter, provider, model: model.id, ...(reasoning ? { reasoning } : {}) } });
      pickerOpen = false;
      await loadDetail(); await refreshPilots();
    } catch (e) { flash(`Couldn’t change the agent: ${errText(e)}`); }
  }
  let chatEl: HTMLElement | undefined = $state();
  let msgsEl: HTMLElement | undefined = $state();
  let composerEl: HTMLTextAreaElement | undefined = $state();
  let bar = $derived(barPilots(pilotsAll, openPilot));
  const PHASE: Record<PilotSummary["phase"], string> = { draft: "draft", working: "working", answered: "answered", interrupted: "interrupted", failed: "failed" };
  /** GET (no body) or POST JSON to the engine; a failure carries the engine's message and status. */
  async function request<T>(base: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${base}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw Object.assign(new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `The engine said ${r.status}.`), { status: r.status });
    return r.json() as Promise<T>;
  }
  const pilotReq = <T,>(path: string, body?: unknown) => request<T>("/api/pilot/chat", path, body);
  const desktopReq = <T,>(path: string, body?: unknown) => request<T>("/api/desktops", path, body);
  /** A route both kinds of desktop share (/session, /stop), on the right one for `id`. */
  const chatReq = <T,>(id: string | null, path: string, body?: unknown) => request<T>(coding(id) ? "/api/desktops" : "/api/pilot/chat", path, body);
  async function refreshPilots(): Promise<void> {
    if (data) return;
    // either list can be missing (an older engine has no /api/desktops): keep the last of each
    const [pilots, desktops] = await Promise.all([
      pilotReq<{ sessions: PilotSummary[] }>("").then((r) => r.sessions, () => null),
      desktopReq<{ desktops: PilotSummary[] }>("").then((r) => r.desktops, () => null),
    ]);
    pilotsAll = [...(pilots ?? pilotsAll.filter((p) => !coding(p.id))), ...(desktops ?? pilotsAll.filter((p) => coding(p.id)))];
  }
  async function loadDetail(): Promise<void> {
    const id = openPilot;
    if (!id) return;
    try {
      const d = await chatReq<PilotDetail>(id, `/session?id=${encodeURIComponent(id)}`);
      if (openPilot === id) detail = d;
    } catch (e) { if (openPilot === id) flash(errText(e)); }
  }
  /** The theme pages are dressed in, read off this view's root, and read again when the theme or
   * light/dark changes. Posted to the engine for pages agents serve themselves (bigbrain.css). */
  let rootEl: HTMLDivElement | undefined = $state();
  let themeTick = $state(0);
  let pageVars: string = $derived.by(() => { void themeTick; return rootEl ? themeVars(rootEl) : ""; });
  $effect(() => {
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const bump = () => { themeTick++; };
    dark.addEventListener("change", bump);
    const watch = new MutationObserver(bump);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => { dark.removeEventListener("change", bump); watch.disconnect(); };
  });
  $effect(() => { if (pageVars && !data) void desktopReq("/theme", { css: themeSheet(pageVars) }).catch(() => {}); });

  /** A coding desktop's live stream: text as it's written, and a refresh when anything else happens. */
  let liveText = $state("");
  /** The step the agent is on right now ("Running git worktree list…"), from the stream. */
  let runningLabel = $state("");
  $effect(() => {
    const id = openPilot;
    if (!id || !coding(id) || data) return;
    liveText = ""; runningLabel = "";
    const es = new EventSource(`/api/desktops/events?id=${encodeURIComponent(id)}&since=${Number.MAX_SAFE_INTEGER}`);
    let pending: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { clearTimeout(pending); pending = setTimeout(() => { void loadDetail(); void refreshPilots(); }, 120); };
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as { type: string; text?: string; label?: string };
      if (e.type === "message.delta") { liveText += e.text ?? ""; return; }
      if (e.type === "tool.start") runningLabel = `${e.label ?? "Working"}…`;
      if (e.type === "tool.end" || e.type === "status") runningLabel = "";
      if (e.type === "message.done") liveText = "";
      refresh();
    };
    es.addEventListener("record", refresh);
    return () => { es.close(); clearTimeout(pending); };
  });
  let live: string = $derived.by(() => (coding(openPilot) ? liveText : detail?.live ?? ""));

  // the bar's pilots, placed over their context, are what the field draws
  $effect(() => {
    const f = field, b = bar;
    if (f && scene) scene.setPilots(placePilots(f, b));
  });
  // keep the scroll at the newest message, unless you have scrolled up to
  // read: it follows again once you are back at the bottom
  let following = true;
  const onMsgsScroll = () => { if (msgsEl) following = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 48; };
  $effect(() => {
    void detail?.messages.length; void live;
    void tick().then(() => { if (msgsEl && following) msgsEl.scrollTop = msgsEl.scrollHeight; });
  });
  function openPilotChat(id: string): void {
    following = true;
    if (searching) { searching = false; scene?.search(null); }
    ent = null; entRows = null;
    openPilot = id; detail = (pilotsAll.find((p) => p.id === id) as PilotDetail | undefined) ?? null;
    if (detail && !detail.messages) detail = { ...detail, messages: [] };
    scene?.openEntity(null);
    scene?.focusPilot(id);
    scene?.shift(shiftFor());
    void loadDetail();
    void tick().then(() => composerEl?.focus());
  }
  function closePilot(): void {
    openPilot = null; detail = null;
    scene?.focusPilot(null);
    overview();
  }
  /** A new session: on `context` (note paths), titled now if `title` is given,
   * else named by the pilot itself once it starts (the engine's own rule). */
  async function createPilot(context: string[], title?: string, labels: string[] = []): Promise<void> {
    try {
      const made = await desktopReq<{ id: string }>("/create", { ...(title ? { title } : {}), context: context.map((path, k) => ({ path, title: labels[k] ?? path })) });
      await refreshPilots();
      openPilotChat(made.id);
      return;
    } catch (e) {
      if ((e as { status?: number }).status !== 404) { flash(`Couldn’t start a desktop: ${errText(e)}`); return; }
    }
    const id = `pilot-${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      const made = await pilotReq<PilotDetail>("/create", { id, context });
      if (title) await pilotReq("/context", { id, nodes: context, title, expectedRevision: made.viewRevision ?? 0 });
      await refreshPilots();
      openPilotChat(id);
    } catch (e) {
      flash(`Couldn’t start a pilot: ${errText(e)}`);
    }
  }
  async function sendDraft(): Promise<void> {
    following = true;
    const id = openPilot, text = draftText.trim();
    if (!id || !text) return;
    draftText = "";
    const inputId = `in-${crypto.randomUUID()}`;
    try {
      // a coding desktop's agent is steered by what you say while it works
      if (coding(id)) await desktopReq(detail?.phase === "working" ? "/steer" : "/send", { id, text, inputId });
      else await pilotReq("/send", { id, text, inputId });
      await loadDetail();
    }
    catch (e) { draftText = text; flash(`Couldn’t send: ${errText(e)}`); }
  }
  async function stopPilot(): Promise<void> {
    if (!openPilot) return;
    try { await chatReq(openPilot, "/stop", { id: openPilot }); await loadDetail(); } catch (e) { flash(errText(e)); }
  }
  /** Bring a fork's committed work home: a PR when the project is on GitHub, else a branch in your copy. */
  async function landProject(project: string): Promise<void> {
    try {
      const r = await desktopReq<{ how: "pr" | "branch"; branch: string; url?: string }>("/land", { id: openPilot, project });
      flash(r.how === "pr" ? `Opened a pull request: ${r.url}` : `Brought ${r.branch} home to ${project}. Merge it there when you're ready.`);
      await loadDetail();
    } catch (e) { flash(errText(e)); }
  }
  let discarding: string | null = $state(null);
  async function discardProject(project: string): Promise<void> {
    if (discarding !== project) { discarding = project; flash(`Click Discard again to delete this desktop's copy of ${project}.`); return; }
    discarding = null;
    try { await desktopReq("/discard", { id: openPilot, project }); await loadDetail(); } catch (e) { flash(errText(e)); }
  }
  /** The bar's ×: archive a desktop, whichever kind. It leaves the bar; its conversation is kept. */
  async function closeDesktop(id: string): Promise<void> {
    try {
      if (coding(id)) await desktopReq("/archive", { id }); else await pilotReq("/deactivate", { id });
      if (openPilot === id) closePilot();
      await refreshPilots();
    } catch (e) { flash(`Couldn’t close it: ${errText(e)}`); }
  }
  const archiveDesktop = (): Promise<void> => (openPilot ? closeDesktop(openPilot) : Promise.resolve());
  /** Chat text: markdown, with [[path|title]] citations as quiet links (as the app draws them). */
  const CITE = "#/vault/";
  const render = (t: string) => sanitizeHtml(md(t.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, path: string, label?: string) =>
    `[${(label ?? path.split("/").pop()!.replace(/\.md$/, "")).replace(/[[\]]/g, "")}](${CITE}${encodeURIComponent(path)})`)));
  /** A citation opens its entity in the field beside the chat, or the note in the app when it isn't drawn. */
  function citation(e: MouseEvent): void {
    const href = (e.target as Element).closest("a")?.getAttribute("href");
    if (!href?.startsWith(CITE)) return;
    e.preventDefault();
    const path = decodeURIComponent(href.slice(CITE.length));
    const i = field?.nodes.find((n) => n.path === path || n.id === path)?.i;
    if (i != null) void openEntity(i); else window.open(`${APP}${href}`, "_blank", "noopener");
  }

  const authorName = (id: string | null) => (id ? writing?.authors.find((a) => a.id === id)?.name ?? id : "You");
  const when = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "2-digit" }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };
  /** Who wrote the recent feed rows that mention an entity. */
  const writersOf = (id: string) => [...new Set(writing!.feed.filter((r) => r.entities.includes(id) && r.author).map((r) => authorName(r.author)))];

  const dueOn = (day: string) => `due ${new Date(`${day}T00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  // newest at the bottom, nearest the eye; older above, a scroll (or k) away;
  // needs-you rows keep their weight
  let sortedShown = $derived(sorted.toReversed());

  // the feed: an opened entity's own record, else the vault's latest
  let rows = $derived.by(() => (!writing ? [] : ent != null && entRows ? entRows.slice(-6) : writing.feed.slice(-6)));
  let hud = $derived.by(() => {
    if (!field || !writing || searching || openPilot) return null;
    if (src) return { eyebrow: [src.row.via, when(src.row.added)].filter(Boolean).join(" · "), name: src.row.title ?? src.row.headline, status: src.text ?? "", writing: src.text === "" };
    if (ent != null) {
      const n = field.nodes[ent]!;
      const tw = (twins.get(ent) ?? []).map((j) => field!.nodes[j]!.label);
      const who = writersOf(n.id);
      return {
        eyebrow: n.memory ? "Memory" : `${n.degree} ${n.degree === 1 ? "tie" : "ties"}`, name: n.label,
        status: (who.length ? `Lately written about by ${who.join(", ")}.` : "") + (tw.length ? ` Also in your vault as “${tw.join("”, “")}”.` : ""),
      };
    }
    return null;
  });

  async function load(): Promise<void> {
    try {
      const [graph, sq] = data ? [data.graph, data.v2] : await Promise.all([api.graph(), api.v2()]);
      writing = sq;
      refreshSorted();
      await drawField(graph);
    } catch (e) {
      error = errText(e);
    }
  }
  let graphHash = "";
  /** The field from /api/graph, drawn anew (a fresh scene: indices change). */
  async function drawField(graph: GraphData): Promise<void> {
    graphHash = graph.hash;
    field = buildField(graph);
    twins = twinsOf(field);
    const { createV2Scene } = await import("../lib/v2/scene");
    scene?.dispose();
    scene = createV2Scene(host, field, {
      blockers: () => [hudEl, feedEl, searching ? searchEl : undefined, chatEl, sidebarEl].filter((e): e is HTMLElement => !!e).map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0),
      onPick,
      onPickPilot: (id) => (openPilot === id ? closePilot() : openPilotChat(id)),
    });
    scene.setPilots(placePilots(field, bar));
  }
  /** The vault changed (the engine's /api/events ping, as the app's views
   * hear it): the feed and the record re-read at once; a changed graph is
   * redrawn when you are at the overview, so nothing moves under a hand. */
  let graphStale = false;
  async function onVaultChange(): Promise<void> {
    refreshSorted();
    void api.v2().then((v) => { writing = v; }).catch(() => {});
    try {
      const g = await api.graph();
      if (g.hash !== graphHash) { graphStale = true; heldGraph = g; }
    } catch { /* the next ping tries again */ }
    redrawIfIdle();
  }
  let heldGraph: GraphData | null = null;
  function redrawIfIdle(): void {
    if (!graphStale || !heldGraph || ent != null || src || searching || openPilot) return;
    graphStale = false;
    void drawField(heldGraph).then(lightCursor);
    heldGraph = null;
  }
  /** The feed changes in the background as tend sorts what it files. */
  function refreshSorted(): void {
    if (!data) void api.v2Sorted().then((f) => { sorted = f.rows; }).catch(() => {});
  }
  onMount(() => {
    void load();
    void refreshPilots();
    let tickN = 0;
    const timer = setInterval(() => {
      tickN++;
      if (openPilot && (detail?.phase === "working" || tickN % 3 === 0)) void loadDetail();
      if (tickN % 4 === 0) void refreshPilots();
      redrawIfIdle(); // a held graph, once you are back at the overview
    }, 1200);
    // pushed, not polled: the engine pings when the vault changes
    const es = data ? null : new EventSource(workspaceURL("/api/events"));
    let pending: ReturnType<typeof setTimeout> | undefined;
    if (es) es.onmessage = () => { clearTimeout(pending); pending = setTimeout(() => void onVaultChange(), 300); };
    return () => { clearInterval(timer); es?.close(); clearTimeout(pending); scene?.dispose(); };
  });

  /** A click in the field: open what's under it; empty space backs out. */
  function onPick(i: number | null): void {
    if (i == null) { if (openPilot) closePilot(); else if ((ent != null || src) && !searching) overview(); return; }
    if (searching) { searching = false; scene?.search(null); }
    if (openPilot) { openPilot = null; detail = null; scene?.focusPilot(null); }
    if (i !== ent) void openEntity(i);
  }
  /** Slide the field's centre clear of the panels: right of a left column, left of the sidebar. */
  const shiftFor = () => {
    const chatW = (chatWidth ?? Math.min(1000, Math.max(520, innerWidth * 0.44))) + GUTTER; // .v2's --chat-w, plus a gutter
    const left = searching ? Math.min(600, innerWidth * 0.4) : openPilot ? chatW : ent != null || src ? Math.min(380, innerWidth * 0.26) : 0;
    if (openPilot && !showDesktop && !searching) return 0; // the chat stands alone, centred
    const right = showDesktop ? innerWidth - chatW - GUTTER : 0;
    return (left - right) / 2;
  };
  function toggleDesktop(): void {
    if (!openPilot || !desktopViews.length) return;
    hidden[openPilot] = !hidden[openPilot];
    void tick().then(() => scene?.shift(shiftFor()));
  }
  function overview(): void {
    ent = null; entRows = null;
    closeSource();
    scene?.overview();
    scene?.shift(shiftFor());
  }

  // ── walking the feed ──────────────────────────────────────────────────
  function closeSource(): void { if (src) { src = null; scene?.search(null); } }
  const feedEntities = (r: V2SortedRow) => r.entities.map((id) => field!.byId.get(id)).filter((x): x is number => x != null);
  const cursorRow = () => sorted.find((r) => r.source === cursor) ?? null;
  /** Light what the row in hand mentions, where it sits in the field. */
  const lightCursor = () => { const r = cursorRow(); scene?.hover(r ? feedEntities(r) : null); };
  /** j (down, newer) and k (up, older): the first press takes the newest row;
   * walking up past the top scrolls the older ones in. */
  function stepFeed(dir: 1 | -1): void {
    if (!sorted.length) return;
    if (ent != null || src) overview();
    const at = sorted.findIndex((r) => r.source === cursor);
    cursor = sorted[at < 0 ? 0 : Math.max(0, Math.min(sorted.length - 1, at - dir))]!.source;
    lightCursor();
    void tick().then(() => feedEl?.querySelector(".row.at")?.scrollIntoView({ block: "nearest" }));
  }
  /** Let go of the walk: the strip settles back on the newest. */
  function leaveFeed(): void {
    cursor = null;
    scene?.hover(null);
    if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  }
  /** Open a feed row's source: its entities lit and framed, the source and
   * Quick's summary of it where an opened entity's name goes. */
  function openSource(r: V2SortedRow): void {
    if (ent != null) { ent = null; entRows = null; }
    cursor = r.source;
    src = { row: r, text: r.path && !data ? "" : undefined };
    scene?.hover(null);
    scene?.search({ matches: feedEntities(r), active: null, move: "frame" });
    scene?.shift(shiftFor());
    if (r.path && !data) void briefing(r.path, (text) => { if (src?.row.source === r.source) src = { row: r, text }; })
      .then((ok) => { if (!ok && src?.row.source === r.source && !src.text) src = { row: r }; });
  }
  $effect(() => { if (sorted.length && feedEl && cursor == null) feedEl.scrollTop = feedEl.scrollHeight; });
  /** A memory topic's own first paragraph: citations dropped, links read as labels. */
  async function memorySummary(path: string): Promise<string | undefined> {
    try {
      const body = (await api.note(path)).content.replace(/^---[\s\S]*?\n---\n/, "");
      const para = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#"));
      if (!para) return undefined;
      const text = plain(para.replace(/\s*\[\[ast_[^\]]*\]\]/g, "")).replace(/[*_`]/g, "");
      return text.length <= 240 ? text : text.slice(0, 239).replace(/\s+\S*$/, "") + "…";
    } catch { return undefined; }
  }

  /** What Shift+Enter starts a pilot on: the active search result, else the
   * feed row in hand (its source), else the opened thing. */
  function inHand(): { path: string; label: string } | null {
    const r = !searching && ent == null ? cursorRow() : null;
    if (r?.path) return { path: r.path, label: r.title ?? r.headline };
    const i = searching ? matches[active] ?? null : ent;
    const n = i == null ? null : field?.nodes[i];
    return n?.path ? { path: n.path, label: n.label } : null;
  }
  /** A pilot on the thing in hand, as the app's lists start one, titled "Re: …". */
  async function startPilot(): Promise<void> {
    const n = inHand();
    if (!n) { flash("Open something first — Shift+Enter starts a pilot on it."); return; }
    await createPilot([n.path], `Re: ${n.label}`, [n.label]);
  }
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  function flash(text: string): void { notice = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice = ""; }, 4200); }

  /** An entity's own latest assertions, dated by when each claim was first recorded. */
  async function entityRows(i: number): Promise<V2FeedRow[]> {
    const n = field!.nodes[i]!;
    if (data) return writing!.feed.filter((r) => r.entities.includes(n.id));
    try { return (await api.v2Entity(n.id)).rows; } catch { return writing!.feed.filter((r) => r.entities.includes(n.id)); }
  }
  /** Quick's briefing on a note — the summary the app shows when you select it.
   * Cached by the engine per note and evidence; a fresh one streams as it's written. */
  async function briefing(path: string, onText: (text: string) => void): Promise<boolean> {
    try {
      const r = await fetch("/api/note/briefing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, stream: true }) });
      if (!r.ok || !r.body) return false;
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "", done = false;
      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        buf += dec.decode(chunk.value ?? new Uint8Array(), { stream: !done });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as { type: string; text?: string; briefing?: { summary: string }; error?: string };
          if (ev.type === "preview" && ev.text) onText(plain(ev.text));
          else if (ev.type === "complete" && ev.briefing) { onText(plain(ev.briefing.summary)); return true; }
          else if (ev.type === "error") return false;
        }
      }
      return false;
    } catch { return false; }
  }
  async function openEntity(i: number): Promise<void> {
    if (!field || !writing) return;
    closeSource();
    ent = i; entRows = null;
    scene?.openEntity(i, neighbours(field, i));
    scene?.shift(shiftFor());
    const n = field.nodes[i]!;
    const ties = neighbours(field, i);
    // beside it: Quick's summary, written live, with a spinner until its first
    // words (a memory shows its own opening lines meanwhile). Never the latest
    // assertion: one claim out of many reads as the whole story.
    const path = data ? undefined : n.path;
    const first = n.memory && path ? await memorySummary(path) : undefined;
    if (ent !== i) return;
    scene?.openEntity(i, ties, first ?? (path ? "" : undefined));
    if (path) void briefing(path, (text) => { if (ent === i) scene?.openEntity(i, ties, text); })
      .then((ok) => { if (!ok && !first && ent === i) scene?.openEntity(i, ties); });
    if (n.memory) {
      // a memory topic is a note, not an entity: its feed is about what it cites
      const cites = new Set(neighbours(field, i, 24).map((j) => field!.nodes[j]!.id));
      entRows = writing.feed.filter((r) => r.entities.some((id) => cites.has(id)));
      return;
    }
    const own = await entityRows(i);
    if (ent === i) entRows = own;
  }

  // ── search by name ─────────────────────────────────────────────────────
  function openSearch(): void {
    searching = true; query = ""; matches = []; active = 0;
    scene?.search({ matches: [], active: null, move: "frame" });
    scene?.shift(shiftFor());
    void tick().then(() => qEl?.focus());
  }
  function closeSearch(): void {
    searching = false;
    clearTimeout(sayTimer);
    scene?.search(null);
    scene?.shift(shiftFor());
    if (ent != null) void openEntity(ent); else scene?.overview();
  }
  function runQuery(): void {
    if (!field) return;
    matches = searchNames(field, query);
    active = 0;
    scene?.search({ matches, active: matches[0] ?? null, move: "frame" });
    sayActive();
  }
  function setActive(k: number): void {
    if (!matches.length) return;
    active = (k + Math.min(matches.length, 9)) % Math.min(matches.length, 9);
    scene?.search({ matches, active: matches[active]!, move: "glide" });
    sayActive();
  }
  let sayTimer: ReturnType<typeof setTimeout> | undefined;
  /** The active match's summary, as a clicked node has it: a spinner, then
   * Quick's words as they arrive. It starts once the arrow keys settle, so
   * passing over a match doesn't ask for one. The camera holds still. */
  function sayActive(): void {
    clearTimeout(sayTimer);
    const i = matches[active];
    if (i == null) return;
    const path = data ? undefined : field!.nodes[i]!.path;
    const show = (text?: string) => { if (searching && matches[active] === i) scene?.search({ matches, active: i, text, move: "none" }); };
    if (!path) return show();
    show("");
    sayTimer = setTimeout(() => void briefing(path, show).then((ok) => { if (!ok) show(); }), 350);
  }
  function commit(k = active): void {
    const i = matches[k];
    if (i == null) return;
    searching = false;
    scene?.search(null);
    void openEntity(i);
  }
  const metaOf = (i: number) => {
    const n = field!.nodes[i]!;
    const who = writersOf(n.id).slice(0, 2);
    const tw = (twins.get(i) ?? []).map((j) => field!.nodes[j]!.label);
    return [`${n.degree} ${n.degree === 1 ? "tie" : "ties"}`, ...(who.length ? [who.join(", ")] : []), ...(tw.length ? [`also “${tw.join("”, “")}”`] : [])].join(" · ");
  };
  const marked = (label: string) => {
    const i = label.toLowerCase().indexOf(query.trim().toLowerCase());
    return i < 0 || !query.trim() ? [label, "", ""] : [label.slice(0, i), label.slice(i, i + query.trim().length), label.slice(i + query.trim().length)];
  };

  /** True when this view took the key. */
  function onKey(e: KeyboardEvent): boolean {
    // ⌘, (ctrl+, elsewhere): settings, the same view the app's gear opens
    if ((e.metaKey || e.ctrlKey) && e.key === ",") { take(e); location.href = `${APP}#/vaultSettings`; return true; }
    if (e.metaKey || e.ctrlKey || e.altKey || !field) return false;
    if ((e.metaKey || e.ctrlKey) && (e.key === "n" || e.key === "N") && !e.shiftKey) { take(e); void createPilot([]); return true; }
    if (e.target === composerEl) {
      // the composer: Enter sends, Shift+Enter is a new line, Esc leaves it
      if (e.key === "Enter" && !e.shiftKey) { take(e); void sendDraft(); return true; }
      if (e.key === "Escape") { take(e); composerEl?.blur(); return true; }
      return false;
    }
    if (searching && e.target === qEl) {
      // typing in the search box is ours entirely; the characters still land
      if (e.key === "ArrowDown") { take(e); setActive(active + 1); }
      else if (e.key === "ArrowUp") { take(e); setActive(active - 1); }
      else if (e.key === "Enter" && e.shiftKey) { take(e); void startPilot(); }
      else if (e.key === "Enter") { take(e); commit(); }
      else if (e.key === "Escape") { take(e); closeSearch(); }
      return true;
    }
    const t = e.target as HTMLElement | null;
    if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return false;
    if (e.key === "/") { take(e); openSearch(); return true; }
    if (e.key === "Escape" && pickerOpen) { take(e); pickerOpen = false; return true; }
    if (e.key === "Escape" && openPilot) { take(e); closePilot(); return true; }
    if (e.key === "Escape" && (ent != null || src)) { take(e); overview(); lightCursor(); return true; }
    if (e.key === "Escape" && cursor) { take(e); leaveFeed(); return true; }
    if (e.key === "n") { take(e); void createPilot([]); return true; }
    const slot = Number(e.key);
    if (slot >= 1 && slot <= bar.length) { take(e); const p = bar[slot - 1]!; if (openPilot === p.id) closePilot(); else openPilotChat(p.id); return true; }
    if (e.key === "\\" && openPilot) { take(e); toggleDesktop(); return true; }
    if (e.key === "j" || e.key === "k") { take(e); stepFeed(e.key === "j" ? 1 : -1); return true; }
    if (e.key === "Enter" && e.shiftKey) { take(e); void startPilot(); return true; }
    if (e.key === "Enter" && cursor && ent == null) { const r = cursorRow(); if (r) { take(e); openSource(r); return true; } }
    return false;
  }
  function take(e: KeyboardEvent): void { e.preventDefault(); e.stopPropagation(); }
</script>

{#snippet tile(t: DesktopTile)}
  {#if "view" in t}
    {@const v = desktopViews.find((x) => x.id === t.view)}
    {#if v}
      <article class="view" aria-label={v.title}>
        <header><span class="vt">{v.title}</span>{#if v.kind === "url"}<a class="vp" href={v.path} target="_blank" rel="noopener" title="Open in a browser">{v.path} ↗</a>{:else if v.kind === "note"}<span class="vp">{v.path}</span>{:else}<span class="vp"></span>{/if}
          <button type="button" class="px" onclick={() => void closeView(v.id)} aria-label={`Close ${v.title}`} title="Close — the agent leaves it closed">×</button></header>
        {#if v.kind === "html"}
          <!-- the agent's page, in this person's theme; scripts don't run -->
          <iframe class="vpage vhtml" sandbox="" title={v.title} srcdoc={pageDoc(v.html ?? "", pageVars)}></iframe>
        {:else if v.kind === "url"}
          <!-- a page on this machine (the engine's CSP allows nothing else) -->
          {#key v.at}<iframe class="vpage" src={v.path} title={v.title} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"></iframe>{/key}
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="vbody" onclick={citation}>
            {#if notes[v.path]?.content != null}{@html render(notes[v.path]!.content!)}
            {:else if notes[v.path]?.error}<p class="activity err">{notes[v.path]!.error}</p>
            {:else}<p class="activity">Opening…</p>{/if}
          </div>
        {/if}
      </article>
    {/if}
  {:else}
    <div class="ws-split ws-{t.dir}">
      {#each t.kids as kid, k (k)}<div class="ws-cell" style:flex-grow={t.weights[k] ?? 1}>{@render tile(kid)}</div>{/each}
    </div>
  {/if}
{/snippet}

<svelte:head>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" />
</svelte:head>
<svelte:window onkeydown={onKey} />

<div class="v2" bind:this={rootEl} style:--chat-w={chatWidth ? `${chatWidth}px` : null}>
  <div class="stage" bind:this={host}></div>

  {#if field}
    <nav class="strip" aria-label="Pilots">
      <!-- the task's full name is the token: no model squeezed in beside it -->
      {#each bar as p, k (p.id)}
        <span class="tokwrap">
          <button type="button" class="tok" class:on={openPilot === p.id} class:working={p.phase === "working"} aria-pressed={openPilot === p.id}
            title={`${p.title} · ${p.model} · ${PHASE[p.phase]} (${k + 1})`} onclick={() => (openPilot === p.id ? closePilot() : openPilotChat(p.id))}>
            <svg width="11" height="11" viewBox="-12 -12 24 24" aria-hidden="true"><path d="M 0 9 L 7.794 -4.5 L -7.794 -4.5 Z" /></svg>
            <span class="k">{k + 1}</span><span class="t">{p.title}</span>
          </button>
          <button type="button" class="tokx" class:on={openPilot === p.id} onclick={() => void closeDesktop(p.id)}
            aria-label={`Close ${p.title}`} title="Close this desktop: its processes stop; its conversation is kept">×</button>
        </span>
      {/each}
      <button type="button" class="new" onclick={() => void createPilot([])} title="New pilot (⌘N)">+ <span class="k">⌘N</span></button>
      <button type="button" class="find" onclick={openSearch}>Search <span class="k">/</span></button>
      <a class="gear" href={`${APP}#/vaultSettings`} title="Settings (⌘,)" aria-label="Settings">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </a>
    </nav>
  {/if}

  {#if hud}
    <header class="hud" bind:this={hudEl}>
      <span class="eyebrow">{hud.eyebrow}</span>
      <h1>{hud.name}</h1>
      {#if hud.writing}<p><span class="spin" aria-label="Writing a summary"></span></p>{:else if hud.status}<p>{hud.status}</p>{/if}
    </header>
  {/if}

  {#if searching && field}
    <div class="search" bind:this={searchEl} role="dialog" aria-label="Search by name">
      <div class="field">
        <input bind:this={qEl} bind:value={query} oninput={() => runQuery()} placeholder="Find anything by name…" aria-label="Find by name" autocomplete="off" spellcheck="false" />
        <span class="k">Esc</span>
      </div>
      {#if query.trim()}
        <p class="count">{matches.length ? `${matches.length} ${matches.length === 1 ? "thing" : "things"} in your vault` : `Nothing in your vault is called “${query.trim()}”.`}</p>
        <ul role="listbox" aria-label="Matches">
          {#each matches.slice(0, 9) as i, k (i)}
            {@const parts = marked(field.nodes[i]!.label)}
            <li role="option" aria-selected={k === active} onmouseenter={() => setActive(k)} onclick={() => commit(k)} onkeydown={() => {}}>
              <span class="dot" style:--r={`${2.2 + Math.min(3.6, Math.log1p(field.nodes[i]!.degree) * 0.62)}px`}></span>
              <span class="ttl">{parts[0]}<mark>{parts[1]}</mark>{parts[2]}</span>
              <span class="meta">{metaOf(i)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if sorted.length && ent == null && !openPilot}
    <div class="feed sorted" class:walking={cursor} bind:this={feedEl} aria-label="Your feed">
      {#each sortedShown as r (r.source)}
        <div class="row s-{r.section}" class:at={r.source === cursor} class:open={r.source === src?.row.source} role="button" tabindex="-1"
          title={r.title && r.title !== r.headline ? r.title : undefined}
          onmouseenter={() => { if (!src) scene?.hover(feedEntities(r)); }}
          onmouseleave={() => { if (!src) lightCursor(); }}
          onclick={() => openSource(r)} onkeydown={() => {}}>
          <span class="w" title="When it entered your feed">{when(r.added)}</span>
          <span class="x">{r.headline}{#if r.due}<span class="due">{dueOn(r.due)}</span>{/if}</span>
        </div>
      {/each}
    </div>
  {:else if rows.length && !openPilot}
    <div class="feed" bind:this={feedEl} aria-label="Latest assertions">
      {#each rows as r (r.id)}
        <div class="row" role="presentation"
          onmouseenter={() => scene?.hover(r.entities.map((id) => field!.byId.get(id)).filter((x): x is number => x != null))}
          onmouseleave={() => scene?.hover(null)}>
          <span class="w" title={r.writtenAt ? `First recorded ${when(r.at)}; this version written ${when(r.writtenAt)}` : undefined}>{when(r.at)}</span>
          <span class="a" class:client={!r.model} title={r.model ? `Written by ${r.by}` : r.author ? `Written through ${authorName(r.author)}; the model it ran isn’t recorded` : "Written by you"}>{r.by}</span>
          <span class="x">{r.text}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if openPilot && detail}
    <section class="chat" class:solo={!showDesktop} bind:this={chatEl} aria-label="Pilot conversation">
      <header>
        <div class="top">
          <div class="who-is">
            {#if renaming}
              <input class="rename" bind:this={renameEl} bind:value={renameText} aria-label="Rename this conversation"
                onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void saveRename(); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); renaming = false; } }}
                onblur={() => void saveRename()} />
            {:else}
              <h2><button type="button" class="title" onclick={startRename} title="Rename">{detail.title}</button></h2>
            {/if}
            <button type="button" class="agent" onclick={() => void openPicker()} title="Change the agent for this conversation"
              disabled={detail.phase === "working"}>{detail.model} <span aria-hidden="true">▾</span></button>
          </div>
          {#if desktopViews.length}<button type="button" class="find" class:lit={showDesktop} onclick={toggleDesktop} title="Show or hide this desktop's views (\)">{desktopViews.length} {desktopViews.length === 1 ? "view" : "views"} <span class="k">\</span></button>{/if}
        </div>
        {#if detail.contextNodes?.length}<p class="ctx">{detail.contextNodes.map((n) => n.title ?? n.id).join(" · ")}</p>{/if}
        {#if detail.changes?.length}
          <div class="forks">
            {#each detail.changes as c (c.project)}
              <span class="fork"><b>{c.project}</b> {c.commits} commit{c.commits === 1 ? "" : "s"}{c.dirty ? ` · ${c.dirty} uncommitted` : ""}
                <button type="button" class="find" onclick={() => void landProject(c.project)} disabled={!c.commits || c.dirty > 0}
                  title={c.dirty ? "Commit the changes first; landing moves commits" : c.commits ? "A pull request when the project is on GitHub, otherwise a branch in your copy" : "Nothing committed yet"}>Land</button>
                <button type="button" class="find" class:lit={discarding === c.project} onclick={() => void discardProject(c.project)} title="Delete this desktop's copy">Discard</button></span>
            {/each}
          </div>
        {/if}
      </header>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="msgs" bind:this={msgsEl} onscroll={onMsgsScroll} onclick={citation}><div class="col">
        {#each detail.messages as m (m.id)}
          {#if m.role === "activity"}<p class="act" class:bad={m.ok === false}>{m.text}</p>
          {:else}<div class="msg {m.role}"><div class="body">{@html render(m.text)}</div></div>{/if}
        {/each}
        {#if live}<div class="msg assistant live"><div class="body">{@html render(live)}</div></div>{/if}
        {#if detail.phase === "working" && !live}<p class="activity">{(coding(detail.id) && runningLabel) || detail.activity || "Working…"}</p>{/if}
        {#if detail.error}<p class="activity err">{detail.error}</p>{/if}
        {#if !detail.messages.length && detail.phase === "draft"}<p class="activity">{coding(detail.id) ? "Ask it anything: it can read your vault and work on your projects." : "Ask it anything — it can read your vault."}</p>{/if}
      </div></div>
      <div class="dock"><div class="composer col">
        <textarea bind:this={composerEl} bind:value={draftText} rows="3" placeholder={`Message ${detail.title}…`} aria-label="Message"></textarea>
        <div class="row">
          <span class="k">{coding(detail.id) && detail.phase === "working" ? "↵ Steer" : "↵ Send"} · ⇧↵ New line · Esc Back</span>
          {#if detail.phase === "working"}<button type="button" class="find" onclick={() => void stopPilot()}>Stop</button>{/if}
          {#if coding(detail.id)}<button type="button" class="find" onclick={() => void archiveDesktop()} title="Stop its processes; its files and conversation stay">Archive</button>
          {:else}<a class="find" href={`${APP}#/session/${detail.id}`}>Open in app</a>{/if}
        </div>
      </div></div>
    </section>
  {/if}
  {#if pickerOpen && detail}
    <div class="scrim" role="presentation" onclick={() => (pickerOpen = false)}></div>
    <div class="picker" role="dialog" aria-label="Choose the agent">
      <p class="eyebrow">Talk to</p>
      {#if !agentsList.length}<p class="none">Loading your agents…</p>{/if}
      {#each agentsList as a (a.id)}
        {@const split = latestPerFamily(a.models)}
        <section>
          <h3>{a.label}</h3>
          {#each pickerAll ? a.models : [...split.latest, ...split.other.filter((m) => m.id === detail?.model)] as m (m.id)}
            <button type="button" class:on={m.id === detail.model} onclick={() => void chooseModel(a, m)}>{m.label}<span class="k">{m.id}</span></button>
          {/each}
        </section>
      {/each}
      {#if !pickerAll && agentsList.some((a) => latestPerFamily(a.models).other.length)}
        <button type="button" class="other" onclick={() => (pickerAll = true)}>Other models<span class="k">{agentsList.reduce((n, a) => n + latestPerFamily(a.models).other.length, 0)} more</span></button>
      {/if}
      <p class="k">Esc to close · the next reply comes from the one you pick</p>
    </div>
  {/if}
  {#if openPilot && detail && showDesktop}
    <div class="split" role="separator" aria-orientation="vertical" aria-label="Resize the chat" title="Drag to resize · double-click to reset"
      onpointerdown={dragSplit} ondblclick={resetSplit}></div>
  {/if}
  {#if showDesktop && detail?.desktop?.layout}
    <aside class="side" bind:this={sidebarEl} aria-label="Desktop">
      {@render tile(detail.desktop.layout)}
    </aside>
  {/if}

  <p class="hints" aria-hidden="true"><span>/ Search</span><span>j k Feed</span>{#if cursor && ent == null}<span>↵ Open</span>{/if}<span>⇧↵ Pilot</span><span>1–9 Pilots</span><span>⌘N New</span>{#if openPilot && desktopViews.length}<span>\ Views</span>{/if}{#if ent != null || src || cursor}<span>Esc Back</span>{/if}</p>
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if error}<p class="error">The v2 view couldn’t load: {error}</p>{/if}
</div>

<style>
  .v2 { --chat-w: clamp(520px, 44vw, 1000px);
    --font-app: "IBM Plex Sans", system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, monospace;
    --v2-muted: color-mix(in srgb, var(--fg) 65%, var(--bg));
    --v2-faint: color-mix(in srgb, var(--fg) 45%, var(--bg));
    position: fixed; inset: 0; background: var(--bg);
    font-family: var(--font-app); color: var(--fg); overflow: hidden;
  }
  .stage { position: absolute; inset: 0; }
  .stage :global(.v2-canvas) { display: block; width: 100%; height: 100%; touch-action: none; }
  .stage :global(.v2-labels) { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .stage :global(.v2-lab) { position: absolute; left: 0; top: 0; white-space: nowrap; will-change: transform, opacity; pointer-events: auto; cursor: pointer;
    text-shadow: 0 0 3px var(--bg), 0 0 8px var(--bg), 0 0 16px var(--bg); }
  .stage :global(.v2-node .t) { font: 400 11px/1.2 var(--font-mono); letter-spacing: -0.01em; color: var(--v2-muted); }
  .stage :global(.v2-node:hover .t) { color: var(--fg); }
  .stage :global(.v2-pilot) { font: 500 11px/1 var(--font-mono); color: var(--v2-muted); }
  .stage :global(.v2-pilot:hover) { color: var(--fg); }
  .stage :global(.v2-pilot.working) { color: color-mix(in srgb, var(--activity) 80%, var(--fg)); }
  .stage :global(.v2-node.memory .t) { font: 500 12px/1.2 var(--font-app); color: var(--fg); }
  .stage :global(.v2-node .q), .stage :global(.v2-node .c) { display: none; }
  .stage :global(.v2-node.full .c:not(:empty)) { display: block; margin-bottom: 6px; font: 600 9px/1 var(--font-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--v2-faint); }
  .stage :global(.v2-node.full .t) { display: none; }
  .stage :global(.v2-node.full .q) { display: block; white-space: normal; width: max-content; max-width: 32ch;
    font: 400 13px/1.45 var(--font-app); color: color-mix(in srgb, var(--fg) 82%, var(--bg)); }
  .stage :global(.v2-node .q b) { font-weight: 600; color: var(--fg); }
  .stage :global(.v2-node .q .spin), .hud .spin { display: inline-block; width: 9px; height: 9px; margin-left: 9px; vertical-align: -1px; border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, var(--fg) 22%, transparent); border-top-color: var(--fg); animation: v2spin .8s linear infinite; }
  @keyframes v2spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .stage :global(.v2-node .q .spin), .hud .spin { animation-duration: 2.4s; } }

  .strip { position: absolute; top: 18px; left: var(--app-gutter, 34px); right: var(--app-gutter, 34px); display: flex; gap: 4px; min-width: 0; z-index: 2; }
  .strip > :global(*) { flex: 0 1 auto; min-width: 0; }
  .strip .find, .strip .gear, .strip .new { flex: none; }
  .find { display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 11px; border: 0; border-radius: 999px;
    background: color-mix(in srgb, var(--bg) 70%, transparent); color: var(--fg); font: 500 13px/1 var(--font-app); cursor: pointer; }
  .find:hover { background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  .k { font: 500 10px/1 var(--font-mono); color: var(--v2-faint); }
  .find { margin-left: auto; color: var(--v2-muted); }
  .tok, .new { display: inline-flex; align-items: center; gap: 7px; height: 30px; max-width: 40ch; padding: 0 12px; border: 0; border-radius: 999px;
    background: color-mix(in srgb, var(--bg) 70%, transparent); color: var(--fg); font: 500 13px/1 var(--font-app); cursor: pointer; }
  .tok .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tok svg { flex: none; fill: currentColor; }
  .tok.working svg { fill: none; stroke: var(--activity); stroke-width: 2.4; }
  .tok:hover, .new:hover { background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  /* the × sits over the token's right end, shown on hover or keyboard focus */
  .tokwrap { position: relative; display: inline-flex; }
  .tokx { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 20px; height: 20px; padding: 0; border: 0; border-radius: 999px;
    background: color-mix(in srgb, var(--fg) 7%, var(--bg)); color: var(--v2-muted); font: 400 14px/1 var(--font-app); cursor: pointer; opacity: 0; transition: opacity .12s; }
  .tokx.on { background: var(--fg); color: color-mix(in srgb, var(--bg) 65%, var(--fg)); }
  .tokwrap:hover .tokx, .tokx:focus-visible { opacity: 1; }
  .tokx:hover { color: var(--fg); }
  .tokx.on:hover { color: var(--bg); }
  .tok.on { background: var(--fg); color: var(--bg); }
  .tok.on .k { color: color-mix(in srgb, var(--bg) 65%, var(--fg)); }
  .new { color: var(--v2-muted); }
  .find.lit { color: var(--fg); }
  /* the chat sits on the ground itself: opaque, fading into the field at its right edge */
  .chat { container-type: inline-size;
    position: absolute; top: 0; bottom: 0; left: 0; width: calc(var(--chat-w) + var(--app-gutter, 34px)); padding: 72px 0 26px var(--app-gutter, 34px); box-sizing: border-box;
    display: flex; flex-direction: column; gap: 10px; background: var(--bg); z-index: 1; }
  .chat::after { content: ""; position: absolute; top: 0; bottom: 0; right: -96px; width: 96px; pointer-events: none;
    background: linear-gradient(to right, var(--bg), color-mix(in srgb, var(--bg) 0%, transparent)); }
  /* with no views the chat stands alone, centred, fading into the field on both sides */
  .chat.solo { left: 50%; transform: translateX(-50%); padding-right: var(--app-gutter, 34px); width: calc(var(--chat-w) + 2 * var(--app-gutter, 34px)); }
  .chat.solo::before { content: ""; position: absolute; top: 0; bottom: 0; left: -96px; width: 96px; pointer-events: none;
    background: linear-gradient(to left, var(--bg), color-mix(in srgb, var(--bg) 0%, transparent)); }
  .chat .top { display: flex; align-items: flex-start; gap: 12px; }
  .chat .who-is { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
  .title { all: unset; cursor: text; border-radius: 4px; }
  .title:hover { box-shadow: 0 0 0 4px color-mix(in srgb, var(--fg) 8%, transparent); background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .rename { width: 100%; box-sizing: border-box; border: 0; outline: none; border-radius: 4px; padding: 0; background: color-mix(in srgb, var(--fg) 8%, var(--bg));
    color: var(--fg); font: 600 17px/1.25 var(--font-app); letter-spacing: -0.01em; }
  .agent { border: 0; padding: 2px 0; background: none; color: var(--v2-muted); font: 500 11.5px/1.3 var(--font-mono); cursor: pointer; }
  .agent:hover:not(:disabled) { color: var(--fg); }
  .agent:disabled { cursor: default; opacity: .6; }
  .scrim { position: absolute; inset: 0; z-index: 5; background: color-mix(in srgb, var(--bg) 40%, transparent); }
  .picker { position: absolute; z-index: 6; top: 110px; left: var(--app-gutter, 34px); width: min(420px, calc(100% - 68px)); max-height: 70vh; overflow-y: auto; padding: 16px;
    border-radius: 12px; background: var(--bg); box-shadow: 0 0 0 1px var(--rule), 0 28px 70px -28px color-mix(in srgb, var(--fg) 45%, transparent); }
  .picker .eyebrow { margin: 0 0 10px; display: block; }
  .picker h3 { margin: 10px 0 4px; font: 600 12px/1.3 var(--font-app); color: var(--v2-muted); }
  .picker button { display: flex; width: 100%; justify-content: space-between; align-items: baseline; gap: 12px; padding: 7px 10px; border: 0; border-radius: 7px; background: none;
    color: var(--fg); font: 400 14px/1.3 var(--font-app); text-align: left; cursor: pointer; }
  .picker button:hover, .picker button.on { background: color-mix(in srgb, var(--fg) 8%, var(--bg)); }
  .picker button.on { font-weight: 600; } .picker button.other { margin-top: 8px; color: var(--v2-muted); }
  .picker > .k { display: block; margin-top: 12px; }
  .picker .none { margin: 0; font: 400 13px/1.4 var(--font-app); color: var(--v2-faint); }
  .chat .top .find { flex: none; margin-top: 4px; height: 24px; }
  .chat header { display: flex; flex-direction: column; gap: 8px; }
  .chat h2 { margin: 0; font: 600 17px/1.25 var(--font-app); letter-spacing: -0.01em; }
  .chat .ctx { margin: 0; font: 400 11px/1.4 var(--font-mono); color: var(--v2-faint); }
  /* one reading column, like Claude or iA Writer: the measure holds near 68
     characters, the type grows a little with the panel, and your messages sit
     in a bubble at the column's right edge; the composer shares the column */
  .msgs, .dock { --chat-fs: clamp(15px, 2.25cqi, 17px); } /* cqi: the .chat panel's width */
  .chat .col { width: calc(100% - 24px); max-width: calc(68 * 0.56 * var(--chat-fs) + 28px); margin-inline: auto; box-sizing: border-box; }
  /* the scrollbar's gutter is kept on both sides of the messages and, empty, of
     the composer's dock: the two columns centre in the same width and line up;
     the column leaves 12px a side for the composer box to reach into */
  .msgs, .dock { scrollbar-gutter: stable both-edges; scrollbar-width: thin; }
  .msgs { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
    scrollbar-color: color-mix(in srgb, var(--fg) 22%, transparent) transparent; }
  .dock { flex: none; overflow: hidden; }
  .msgs .col { display: flex; flex-direction: column; gap: 24px; padding-bottom: 8px; }
  .msg { display: flex; }
  .msg.user { align-self: flex-end; max-width: 85%; }
  .msg .body { min-width: 0; font: 400 var(--chat-fs)/1.65 var(--font-app); color: color-mix(in srgb, var(--fg) 92%, var(--bg)); overflow-wrap: anywhere; }
  .msg.user .body { padding: 10px 16px; border-radius: 16px; background: color-mix(in srgb, var(--fg) 9%, var(--bg)); color: var(--fg); }
  .msg .body :global(> :first-child) { margin-top: 0; } .msg .body :global(> :last-child) { margin-bottom: 0; }
  .msg .body :global(p) { margin: 0 0 0.85em; }
  .msg .body :global(ul), .msg .body :global(ol) { margin: 0 0 0.85em; padding-left: 1.5em; }
  .msg .body :global(li) { margin: 0; padding-left: 0.2em; } .msg .body :global(li + li) { margin-top: 0.4em; }
  .msg .body :global(li > p) { margin: 0; } .msg .body :global(li > ul), .msg .body :global(li > ol) { margin: 0.4em 0 0; }
  .msg .body :global(li::marker) { color: var(--v2-muted); }
  .msg .body :global(h1), .msg .body :global(h2), .msg .body :global(h3), .msg .body :global(h4) { margin: 1.3em 0 0.5em; font: 600 calc(var(--chat-fs) * 1.06)/1.35 var(--font-app); letter-spacing: -0.005em; }
  .msg .body :global(strong) { font-weight: 600; color: var(--fg); }
  .msg .body :global(a) { color: inherit; text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--fg) 35%, transparent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
  .msg .body :global(a[href^="#/vault/"]) { font-size: 0.9em; color: var(--v2-muted); }
  .msg .body :global(a:hover) { color: var(--fg); text-decoration-color: currentColor; }
  .msg .body :global(blockquote) { margin: 0 0 0.85em; padding-left: 1em; border-left: 2px solid var(--rule); color: var(--v2-muted); }
  .msg .body :global(hr) { border: 0; border-top: 1px solid var(--rule); margin: 1.4em 0; }
  .msg .body :global(code) { font: 400 0.86em/1.4 var(--font-mono); padding: 0.1em 0.3em; border-radius: 4px; background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .msg .body :global(pre) { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 0.85em; padding: 12px 14px; border-radius: 8px; background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  .msg .body :global(pre code) { padding: 0; background: none; }
  .msg .body :global(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 0 0 0.85em; font-size: 0.92em; }
  .msg .body :global(th), .msg .body :global(td) { border: 1px solid var(--rule); padding: 0.4em 0.65em; vertical-align: top; text-align: left; }
  .msg.live .body { color: var(--v2-muted); }
  .activity { margin: 0; font: 400 12px/1.4 var(--font-mono); color: var(--v2-faint); }
  .activity.err { color: color-mix(in srgb, var(--activity) 80%, var(--fg)); }
  .composer { display: flex; flex-direction: column; gap: 8px; }
  /* the box reaches past the column by its padding, so typed text lines up with the messages' */
  .composer textarea { margin-inline: -12px; resize: none; border: 0; border-radius: 8px; padding: 9px 12px; background: color-mix(in srgb, var(--fg) 7%, var(--bg)); color: var(--fg);
    font: 400 var(--chat-fs)/1.45 var(--font-app); outline: none; }
  .composer textarea::placeholder { color: color-mix(in srgb, var(--fg) 55%, transparent); opacity: 1; }
  .composer .row { display: flex; align-items: center; gap: 8px; }
  .composer .row .k { margin-right: auto; }
  .composer a.find { text-decoration: none; }
  /* the desktop's views take every pixel the chat doesn't */
  .split { position: absolute; z-index: 2; top: 62px; bottom: 26px; left: calc(var(--chat-w) + 2 * var(--app-gutter, 34px)); width: 14px; transform: translateX(-50%); cursor: col-resize; touch-action: none; }
  .split::after { content: ""; position: absolute; top: 0; bottom: 0; left: 6px; width: 2px; border-radius: 1px; background: var(--fg); opacity: 0; transition: opacity .15s; }
  .split:hover::after, .split:active::after { opacity: .35; }
  .side { position: absolute; top: 62px; bottom: 26px; right: var(--app-gutter, 34px); left: calc(var(--chat-w) + 3 * var(--app-gutter, 34px)); z-index: 1;
    display: flex; flex-direction: column; gap: 8px; }
  .side > .ws-split, .side > .view { flex: 1; min-height: 0; }
  .ws-split { display: flex; gap: 10px; min-width: 0; min-height: 0; }
  .ws-split.ws-row { flex-direction: row; } .ws-split.ws-col { flex-direction: column; }
  .ws-cell { flex-basis: 0; min-width: 0; min-height: 0; display: flex; }
  .ws-cell > :global(*) { flex: 1; min-width: 0; min-height: 0; }
  /* a view: a document beside the chat, set in the chat's own type */
  .view { --chat-fs: 15px; display: flex; flex-direction: column; min-width: 0; min-height: 0; border-radius: 12px; overflow: hidden;
    background: var(--bg); box-shadow: 0 0 0 1px var(--rule); }
  .view header { display: flex; align-items: baseline; gap: 10px; padding: 12px 10px 10px 18px; border-bottom: 1px solid var(--rule); }
  .view .vt { font: 600 14px/1.3 var(--font-app); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .view .vp { flex: 1; min-width: 0; font: 400 11px/1.3 var(--font-mono); color: var(--v2-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .view .px { flex: none; border: 0; background: none; color: var(--v2-faint); font: 400 17px/1 var(--font-app); cursor: pointer; padding: 2px 6px; border-radius: 6px; }
  .view .px:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .vbody { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 22px 22px; font: 400 var(--chat-fs)/1.65 var(--font-app); color: color-mix(in srgb, var(--fg) 92%, var(--bg));
    overflow-wrap: anywhere; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--fg) 22%, transparent) transparent; }
  .vbody > :global(*) { max-width: 72ch; }
  .vpage { flex: 1; min-height: 0; width: 100%; border: 0; background: #fff; }
  .vpage.vhtml { background: var(--bg); }
  .act { margin: -12px 0; font: 400 12px/1.5 var(--font-mono); color: var(--v2-faint); }
  .act::before { content: "· "; }
  .act.bad { color: color-mix(in srgb, var(--activity) 80%, var(--fg)); }
  .act.bad::before { content: "× "; }
  .forks { display: flex; flex-wrap: wrap; gap: 6px 16px; font: 400 12px/1.6 var(--font-mono); color: var(--v2-muted); }
  .fork { display: inline-flex; align-items: baseline; gap: 8px; }
  .fork b { font-weight: 500; color: var(--fg); }
  .fork .find { font-size: 12px; }
  .fork .find:disabled { opacity: .45; cursor: default; }
  .vbody :global(> :first-child) { margin-top: 0; } .vbody :global(p) { margin: 0 0 0.85em; }
  .vbody :global(ul), .vbody :global(ol) { margin: 0 0 0.85em; padding-left: 1.5em; } .vbody :global(li + li) { margin-top: 0.3em; }
  .vbody :global(h1), .vbody :global(h2), .vbody :global(h3), .vbody :global(h4) { margin: 1.2em 0 0.45em; font: 600 calc(var(--chat-fs) * 1.08)/1.35 var(--font-app); }
  .vbody :global(h1) { font-size: calc(var(--chat-fs) * 1.3); }
  .vbody :global(a) { color: inherit; text-decoration-color: color-mix(in srgb, var(--fg) 35%, transparent); text-underline-offset: 3px; }
  .vbody :global(a[href^="#/vault/"]) { color: var(--v2-muted); font-size: 0.92em; }
  .vbody :global(code) { font: 400 0.86em/1.4 var(--font-mono); } .vbody :global(pre) { white-space: pre-wrap; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  .vbody :global(blockquote) { margin: 0 0 0.85em; padding-left: 1em; border-left: 2px solid var(--rule); color: var(--v2-muted); }
  .vbody :global(table) { display: block; overflow-x: auto; border-collapse: collapse; font-size: 0.92em; } .vbody :global(th), .vbody :global(td) { border: 1px solid var(--rule); padding: 0.35em 0.6em; }
  .gear { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 999px; color: var(--v2-muted); }
  .gear:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }

  .hud { position: absolute; top: 72px; left: var(--app-gutter, 34px); width: min(460px, calc(100% - 32px)); display: flex; flex-direction: column; gap: 9px;
    pointer-events: none; text-shadow: 0 0 8px var(--bg), 0 0 18px var(--bg); }
  .eyebrow { font: 600 10px/1 var(--font-app); letter-spacing: 0.24em; text-transform: uppercase; color: var(--v2-muted); }
  h1 { margin: 0; font: 500 clamp(28px, 2.5vw, 36px)/1.05 var(--font-app); letter-spacing: -0.03em; }
  .hud p { margin: 0; max-width: 44ch; font: 400 14.5px/1.5 var(--font-app); color: color-mix(in srgb, var(--fg) 80%, var(--bg)); }

  .search { position: absolute; top: 62px; left: calc(var(--app-gutter, 34px) - 8px); width: min(480px, calc(100% - 32px)); z-index: 2;
    border-radius: 11px; background: var(--bg); box-shadow: 0 0 0 1px var(--rule), 0 28px 70px -28px color-mix(in srgb, var(--fg) 45%, transparent); overflow: hidden; }
  .field { display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 18px; }
  .field input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--fg); font: 400 19px/1 var(--font-app); }
  /* the theme's own ink, softened — never the browser's grey */
  .field input::placeholder { color: color-mix(in srgb, var(--fg) 55%, transparent); opacity: 1; }
  .count { margin: 0; padding: 12px 22px 6px; border-top: 1px solid var(--rule); font: 600 10px/1 var(--font-app); letter-spacing: 0.24em; text-transform: uppercase; color: var(--v2-muted); }
  ul { list-style: none; margin: 0; padding: 4px 6px 8px; max-height: min(62vh, 560px); overflow-y: auto; }
  li { display: grid; grid-template-columns: 22px minmax(0, 1fr); grid-template-rows: auto auto; column-gap: 10px; padding: 9px 12px; border-radius: 8px; cursor: pointer; }
  li[aria-selected="true"] { background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  .dot { grid-row: span 2; align-self: center; justify-self: center; width: calc(var(--r) * 2); height: calc(var(--r) * 2); border-radius: 50%; background: var(--fg); }
  .ttl { font: 500 15px/1.3 var(--font-app); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  mark { background: none; color: color-mix(in srgb, var(--activity) 80%, var(--fg)); font-weight: 600; }
  .meta { font: 400 12.5px/1.35 var(--font-app); color: var(--v2-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .feed { position: absolute; left: var(--app-gutter, 34px); bottom: 26px; width: min(880px, calc(100% - 68px)); display: flex; flex-direction: column; gap: 1px;
    font: 400 12.5px/1.35 var(--font-app); text-shadow: 0 0 6px var(--bg), 0 0 14px var(--bg); }
  .row { display: grid; grid-template-columns: 92px 120px minmax(0, 1fr); gap: 12px; align-items: baseline; padding: 2px 0; white-space: nowrap; cursor: default; transition: opacity .12s ease; }
  .row .w { font: 500 9.5px/1 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--v2-faint); font-variant-numeric: tabular-nums; }
  .row .a { font: 500 11px/1 var(--font-mono); overflow: hidden; text-overflow: ellipsis; }
  .row .a.client { color: var(--v2-muted); }
  .row .x { overflow: hidden; text-overflow: ellipsis; color: color-mix(in srgb, var(--fg) 82%, var(--bg)); }
  .row:nth-last-child(2) { opacity: .7; } .row:nth-last-child(3) { opacity: .5; } .row:nth-last-child(4) { opacity: .36; }
  .row:nth-last-child(5) { opacity: .25; } .row:nth-last-child(6) { opacity: .16; }
  .feed:hover .row { opacity: .45; } .feed .row:hover { opacity: 1; } .row:hover .x { color: var(--fg); }
  /* the sorted feed: weight by section, not age */
  .sorted .row { opacity: 1; grid-template-columns: 92px minmax(0, 1fr); } .sorted .row.s-agent { opacity: .78; } .sorted .row.s-know { opacity: .55; }
  .sorted .due { margin-left: 10px; font: 500 9.5px/1 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--activity); }
  /* about eight rows tall; older ones scroll in above, fading at the top edge */
  .feed.sorted { display: block; max-height: 156px; overflow-y: auto; scrollbar-width: none; overscroll-behavior: contain;
    mask-image: linear-gradient(to bottom, transparent, #000 40px); }
  .feed.sorted::-webkit-scrollbar { display: none; }
  .sorted .row { cursor: pointer; }
  .sorted .row.at, .sorted .row.open { opacity: 1; } .sorted .row.at .x, .sorted .row.open .x { color: var(--fg); }
  .sorted .row.at .w { color: var(--activity); }
  .sorted.walking:not(:hover) .row:not(.at):not(.open) { opacity: .4; }
  .hints { position: absolute; right: var(--app-gutter, 34px); bottom: 26px; margin: 0; display: flex; gap: 18px; pointer-events: none;
    font: 600 10px/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--v2-faint); }
  .notice { position: absolute; right: var(--app-gutter, 34px); bottom: 50px; max-width: 46ch; margin: 0; padding: 9px 12px; border-radius: 8px;
    background: color-mix(in srgb, var(--fg) 8%, var(--bg)); font: 400 13px/1.4 var(--font-app); color: var(--fg); }
  .error { position: absolute; top: 80px; left: var(--app-gutter, 34px); font: 400 13px/1.5 var(--font-app); color: var(--v2-muted); }
  @media (max-width: 700px) {
    .row { grid-template-columns: 72px minmax(0, 1fr); } .row .w { display: none; }

  }
</style>
