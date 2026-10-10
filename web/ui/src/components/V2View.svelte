<script lang="ts">
  // /v2 (its own page, v2.html) — the vault as a field, and the record
  // read as it lands, each assertion with its author. The canvas is
  // lib/v2/scene.ts (three.js, loaded on demand); everything with words
  // is here. Keys: / search by name, j/k walk the feed (Enter opens a row's
  // source as a draft desktop: kept once you message it, gone on Esc), Shift+Enter starts a pilot on what's in hand ("Re: …"), ⌘N (or n) a blank
  // one the pilot names itself, \ shows or hides the desktop's views, Esc back out.
  // Pilots are the real agents: /api/pilot/chat sessions, placed over their
  // context, and their chat opens here as a flat column over the field.
  import { onMount, tick } from "svelte";
  import { api } from "../lib/api";
  import { app, goto, gotoLens } from "../lib/store.svelte";
  import { reloadSharedConnections, sharedSettings } from "../lib/sharedSettings.svelte";
  import { selectedWorkspace } from "../lib/vaultScope";
  import type { FoldGroup, GraphData } from "../lib/types";
  import { barPilots, buildField, foldOffer, latestPerFamily, neighbours, placePilots, searchFound, searchNames, sourceItems, twinsOf, type Field, type PilotSummary, type V2Feed, type V2FeedRow } from "../lib/v2/model";
  import { md, sanitizeHtml } from "../lib/markdown";
  import { Readability } from "@mozilla/readability";
  import { openExternal } from "../lib/native";
  import { openOrigin } from "../lib/origin";
  import { pageDoc, themeSheet, themeVars } from "../lib/pageTheme";
  import { otherLoopback } from "../lib/loopbackFrame";
  import type { V2Scene } from "../lib/v2/scene";
  import { plainText as plain, type V2SortedRow } from "../../../../lib/v2Feed";
  import type { DesktopTile, DesktopView } from "../../../../lib/pilotDesktop";
  import { DEFAULT_PILOT_BACKEND } from "../../../../lib/pilotBackendTypes";
  import DesktopCube from "./DesktopCube.svelte";
  import PilotMentionComposer from "./PilotMentionComposer.svelte";
  import ShortcutsSheet from "./ShortcutsSheet.svelte";
  import { keyText, registerShortcuts, RANK } from "../lib/shortcuts.svelte";
  import { keyboardHints } from "../lib/keyboardHints.svelte";
  import { graphSources } from "../lib/graphSources.svelte";
  import { serializeMentions, type MentionItem } from "../../../../lib/pilotMentions";
  import { mentionRecents, mentionSearch } from "../lib/mentionSources";

  /** The workbench hands in fabricated data; the app fetches the vault's.
   * `paused`: the base's settings panel is over the field, and has the keys. */
  let { data = null, paused = false }: { data?: { graph: GraphData; v2: V2Feed } | null; paused?: boolean } = $props();
  /** Settings: the base's panel, over the field (FieldView); a preview has none. */
  const openSettings = () => goto("vaultSettings");

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
  /** Bumped when the scene is drawn anew, so what it's showing is handed back. */
  let sceneRev = $state(0);
  let twins = new Map<number, number[]>();
  /** The memory pass's standing fold proposals (/api/entity/folds). */
  let folds: FoldGroup[] = $state([]);
  /** Pairs you said are not one thing: never offered again. */
  let foldsApart: Array<[string, string]> = $state([]);
  let folding = $state(false);

  let ent: number | null = $state(null);
  let entRows: V2FeedRow[] | null = $state(null);
  /** The sorted feed (lib/feedStage.ts), when the vault has one. */
  let sorted: V2SortedRow[] = $state([]);
  /** The feed row j/k has in hand (by source), and the source opened from it
   * with Quick's summary of it ("" while it is written). */
  let cursor: string | null = $state(null);
  let src: { row: V2SortedRow; text?: string } | null = $state(null);
  /** An assertion clicked in the feed: what it mentions selected in the
   * field, the claim itself where an opened thing's name goes. `rows` is the
   * feed it was clicked in, held while it's open. */
  let claim: { row: V2FeedRow; rows: V2FeedRow[] } | null = $state(null);
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
    servers?: Array<{ port: number; command?: string }>;
    /** Coding desktops holding untrusted material: what it was, and the last command its shell refused. */
    taint?: { sources: Array<{ via: string; title: string }>; refused?: { command: string } };
    /** Coding desktops: a host the agent asked its commands may reach, until the person answers. */
    hostRequest?: { host: string; reason: string; untrusted: boolean } };
  /** Coding desktops (lib/codingDesktops.ts) have `d-` ids and live at /api/desktops;
   * Pilot conversations keep their own routes. One switch, so the rest of the view is shared. */
  const coding = (id: string | null | undefined): boolean => !!id && id.startsWith("d-");
  /** A draft desktop: a feed item opened as a desktop (its source beside an
   * empty chat), held only here. Your first message makes it a real coding
   * desktop, in the bar from then on; Esc before that and it's gone. */
  const drafting = (id: string | null | undefined): boolean => !!id && id.startsWith("draft:");
  let draft: { row: V2SortedRow; path: string; model?: string; titled?: boolean } | null = null;
  /** The Pilot model from Settings › Models, as last read: what a draft desktop will start on. */
  let pilotModel = DEFAULT_PILOT_BACKEND.model;
  let pilotsAll: PilotSummary[] = $state([]);
  let openPilot: string | null = $state(null);
  let detail: PilotDetail | null = $state(null);
  /** Each desktop as last loaded: going back to one draws it at once, views and all, while
   * its /session reload runs, rather than a lone chat that jumps aside when the reload lands. */
  const seen = new Map<string, PilotDetail>();
  let draftText = $state("");
  /** A desktop is the chat plus the views its agent chose to show beside it
   * (lib/pilotDesktop.ts): the engine holds them, so they survive reloads and
   * the agent sees what is open. With none (or hidden with \) the chat stands
   * alone, centred. You can close a view; the agent leaves it closed. */
  let hidden: Record<string, boolean> = $state({});
  let desktopViews: DesktopView[] = $derived.by(() => detail?.desktop?.views ?? []);
  let showDesktop = $derived(!!openPilot && desktopViews.length > 0 && !hidden[openPilot]);
  /** A note view's text; a source (a saved email, article, meeting…) also
   * carries how it came in, and Quick's summary of it to read first. */
  /** `page`: the host the source's page was read from, when it read better than what was saved. */
  type SourceMeta = { via: string; date?: string; header: Array<[string, string]>; summary?: string; html: string; page?: string };
  let notes: Record<string, { content?: string; error?: string; source?: SourceMeta }> = $state({});
  /** Settings → Security: whether sources may load their images and pages
   * (the engine refuses them otherwise). Asked again whenever a desktop opens. */
  let remoteOk = true;
  let remoteCheck: Promise<boolean> = Promise.resolve(true);
  const checkRemote = () => { remoteCheck = data ? Promise.resolve(false) : api.config().then((c) => (remoteOk = c.security?.remote_content ?? true), () => remoteOk); };
  $effect(() => {
    for (const v of desktopViews) if (v.kind === "note" && !notes[v.path]) {
      notes[v.path] = {};
      Promise.all([api.note(v.path), remoteCheck]).then(([r]) => {
        // only a source the engine says a person or a feed sent in reaches out unasked
        const held = r.byAgent !== false;
        notes[v.path] = asSource(r.content, v.title, held);
        if (notes[v.path]!.source && !data) {
          void briefing(v.path, (text) => { const n = notes[v.path]; if (n?.source) n.source = { ...n.source, summary: text }; });
          const origin = (r as { origin?: { url?: string } }).origin?.url;
          if (remoteOk && !held && origin && notes[v.path]!.source!.via !== "email") void readPage(v.path, origin, notes[v.path]!.content ?? "");
        }
      }).catch((e) => { notes[v.path] = { error: errText(e) }; });
    }
  });
  const HEADER = /^(From|To|Cc|Date|Inbox|Subject|Attendees):\s*(.*)$/;
  /** A source note reads as the source: its title and mail headers lifted out of the body.
   * `held`: its remote pictures wait for a click (cleanHtml). */
  function asSource(raw: string, title: string, held: boolean): { content: string; source?: SourceMeta } {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(raw);
    const body = fm ? raw.slice(fm[0].length) : raw;
    const field = (k: string) => fm?.[1].match(new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, "m"))?.[1];
    if (field("type") !== "source") return { content: body };
    const lines = body.replace(/^\s+/, "").split("\n");
    if (/^# /.test(lines[0] ?? "") && lines[0]!.slice(2).trim() === (field("title") ?? title).trim()) lines.shift();
    while (lines[0] === "") lines.shift();
    const header: Array<[string, string]> = [];
    for (let m; lines.length && (m = HEADER.exec(lines[0]!)); lines.shift()) if (m[1] !== "Date" && m[1] !== "Inbox") header.push([m[1]!, m[2]!]);
    const via = (field("source_id") ?? "").split("-")[0] || "source";
    const content = lines.join("\n");
    return { content, source: { via, date: field("date"), header, html: readable(content, field("title") ?? title, held) } };
  }
  /** The source's page, read: kept when it holds clearly more of the piece than was saved (an RSS
   * item saves a line or two; a clip saves the page around the article too). */
  async function readPage(path: string, url: string, saved: string): Promise<void> {
    try {
      const r = await fetch(`/api/remote-page?url=${encodeURIComponent(url)}`);
      if (!r.ok) return;
      const at = r.headers.get("x-final-url") ?? url;
      const doc = new DOMParser().parseFromString(await r.text(), "text/html");
      // absolute addresses before Readability moves things around
      for (const el of doc.querySelectorAll("[src], [href]")) for (const k of ["src", "href"]) {
        const v = el.getAttribute(k);
        if (v && !/^(#|data:|mailto:)/i.test(v)) try { el.setAttribute(k, new URL(v, at).href); } catch { /* left as it was */ }
      }
      const article = new Readability(doc, { keepClasses: false }).parse();
      const text = article?.textContent?.trim().length ?? 0;
      const savedText = new DOMParser().parseFromString(md(saved), "text/html").body.textContent?.trim().length ?? 0;
      if (!article?.content || text < 400 || text < savedText * 0.6) return;
      const n = notes[path];
      if (n?.source) n.source = { ...n.source, html: cleanHtml(article.content, false), page: new URL(at).hostname.replace(/^www\./, "") };
    } catch { /* the saved text stands */ }
  }
  const IMAGE_URL = /\.(png|jpe?g|gif|webp|avif)(\?|$)|\/image\/fetch\//i;
  /** A source as a reader view would show it: Readability keeps the article
   * and drops the page around it (sign-in prompts, avatars, "discover more");
   * its pictures come through the engine (/api/remote-image), and the bare
   * "full size" link a page puts under each picture goes. */
  function readable(markdown: string, title: string, held: boolean): string {
    const doc = new DOMParser().parseFromString(`<!doctype html><title></title><body><article>${md(markdown)}</article>`, "text/html");
    doc.title = title;
    const whole = doc.body.textContent?.trim().length ?? 0;
    const article = whole > 600 ? new Readability(doc.cloneNode(true) as Document, { keepClasses: false }).parse() : null;
    // a short note (most mail) is all content already; a reading that lost most of the text isn't trusted
    return cleanHtml(article?.content && (article.textContent?.trim().length ?? 0) > whole * 0.5 ? article.content : doc.body.innerHTML, held);
  }
  /** `held`: a remote picture is drawn as its host and a Load image button
   * (loadHeld) instead of being fetched — an agent's source names addresses
   * of its writer's choosing, and loading one is a request there. */
  function cleanHtml(html: string, held: boolean): string {
    const out = new DOMParser().parseFromString(html, "text/html");
    // a <picture>'s sources name the remote files directly; its <img> alone comes through the engine
    for (const el of out.querySelectorAll("picture source")) el.remove();
    for (const img of out.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      // remote content off: a picture is left out, not drawn broken
      if (/^https?:\/\//i.test(src) && !remoteOk) { img.remove(); continue; }
      if (/^https?:\/\//i.test(src) && held) { img.replaceWith(heldImage(out, src)); continue; }
      if (/^https?:\/\//i.test(src)) img.setAttribute("src", `/api/remote-image?url=${encodeURIComponent(src)}`);
      img.removeAttribute("srcset"); img.setAttribute("loading", "lazy");
    }
    for (const a of out.querySelectorAll("a")) {
      const href = a.getAttribute("href") ?? "";
      const bare = a.textContent?.trim() === href || !a.textContent?.trim();
      const block = a.parentElement?.tagName === "P" && a.parentElement.textContent?.trim() === a.textContent?.trim() ? a.parentElement : a;
      if (bare && IMAGE_URL.test(href) && !a.querySelector("img") && block.previousElementSibling?.querySelector("img, picture")) block.remove();
    }
    return sanitizeHtml(out.body.innerHTML);
  }
  function heldImage(doc: Document, src: string): HTMLElement {
    const box = doc.createElement("span"), host = doc.createElement("span"), load = doc.createElement("button");
    box.className = "held";
    try { host.textContent = new URL(src).hostname.replace(/^www\./, ""); } catch { /* the button alone */ }
    load.type = "button"; load.textContent = "Load image"; load.dataset.remoteImage = src;
    box.append(host, load);
    return box;
  }
  /** Load image: the held picture, fetched through the engine like any other. */
  function loadHeld(e: MouseEvent): boolean {
    const load = (e.target as Element).closest("button[data-remote-image]");
    if (!load) return false;
    const img = document.createElement("img");
    img.src = `/api/remote-image?url=${encodeURIComponent(load.getAttribute("data-remote-image")!)}`;
    img.alt = "";
    load.parentElement!.replaceWith(img);
    return true;
  }
  /** The source in front, whose original ⌘O opens: a draft desktop's, or the panel's. */
  const original = (): string | undefined => data ? undefined : draft?.path ?? src?.row.path;
  /** ⌘O: the open source's origin, handed to the OS (lib/origin.ts): its page
   * in the browser, a dropped file in the app that reads it, a text-only drop
   * as a Markdown copy. Field draws none of them itself. */
  async function openOriginal(path: string): Promise<void> {
    try {
      const { origin } = await api.note(path);
      if (!origin) throw new Error("Nothing to open for this source.");
      await openOrigin(origin, path, { external: openExternal, engine: api.openSource });
    } catch (e) { flash(`Couldn’t open it: ${errText(e)}`); }
  }

  async function closeView(view: string): Promise<void> {
    if (!openPilot) return;
    if (drafting(openPilot) && detail?.desktop) {
      const views = detail.desktop.views.filter((v) => v.id !== view);
      detail = { ...detail, desktop: { views, layout: views[0] ? { view: views[0].id } : null, arrangedBy: null } };
      void tick().then(() => scene?.shift(shiftFor()));
      return;
    }
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
  // the shortcuts sheet (?), drawn from the registry (lib/shortcuts.svelte.ts)
  let shortcutsOpen = $state(false);
  function startRename(): void {
    if (!detail) return;
    renameText = detail.title; renaming = true;
    void tick().then(() => { renameEl?.focus(); renameEl?.select(); });
  }
  async function saveRename(): Promise<void> {
    const id = openPilot, title = renameText.trim();
    renaming = false;
    if (!id || !title || title === detail?.title) return;
    if (drafting(id) && detail && draft) { detail = { ...detail, title }; draft.titled = true; return; }
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
    if (drafting(openPilot) && detail && draft) { draft.model = `${provider}/${model.id}`; detail = { ...detail, model: model.id }; pickerOpen = false; return; }
    try {
      if (coding(openPilot)) await desktopReq("/model", { id: openPilot, model: `${provider}/${model.id}` });
      else await pilotReq("/backend", { id: openPilot, backend: { adapter, provider, model: model.id, ...(reasoning ? { reasoning } : {}) } });
      pickerOpen = false;
      await loadDetail(); await refreshPilots();
    } catch (e) { flash(`Couldn’t change the agent: ${errText(e)}`); }
  }
  let chatEl: HTMLElement | undefined = $state();
  let msgsEl: HTMLElement | undefined = $state();
  // one side of .msgs' scrollbar gutter, which the composer's dock matches
  let gutter = $state(0);
  $effect(() => {
    const el = msgsEl;
    if (!el) return;
    const measure = () => { gutter = Math.max(0, (el.offsetWidth - el.clientWidth) / 2); };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  });
  // the desktop's composer: @ mentions from recents and the vault's search (lib/mentionSources.ts)
  let composer: PilotMentionComposer | undefined = $state();
  let composerEl: HTMLElement | undefined = $state();
  let mentionRecentItems = $state<MentionItem[]>([]), mentionRecentLoading = $state(false), mentionRecentError = $state(false);
  /** Where the next page of recents starts; null once the oldest is in. */
  let mentionRecentNext: number | null = 0;
  /** The newest recents, or (`more`) the page after those in hand: the @ menu
   * and the empty search both run on as you scroll, as the feed does. */
  function loadMentionRecents(more = false): void {
    if (mentionRecentLoading || (more && mentionRecentNext == null)) return;
    mentionRecentLoading = true; mentionRecentError = false;
    mentionRecents(more ? mentionRecentNext! : 0).then(({ items, next }) => {
      const seen = new Set(more ? mentionRecentItems.map((m) => m.id) : []);
      mentionRecentItems = more ? [...mentionRecentItems, ...items.filter((m) => !seen.has(m.id))] : items;
      mentionRecentNext = next;
      // the search, open and empty, lists them too: the first is in hand
      if (!more && searching && !query.trim()) { active = 0; showActive(); sayActive(); }
    })
      .catch(() => { mentionRecentError = true; }).finally(() => { mentionRecentLoading = false; });
  }
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
    if (!id || drafting(id)) return;
    try {
      const d = await chatReq<PilotDetail>(id, `/session?id=${encodeURIComponent(id)}`);
      seen.set(id, d);
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

  // the bar's pilots, placed among their context, are what the field draws
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
    openPilot = id; detail = seen.get(id) ?? (pilotsAll.find((p) => p.id === id) as PilotDetail | undefined) ?? null;
    checkRemote();
    for (const [path, n] of Object.entries(notes)) if (n.source) delete notes[path];
    if (detail && !detail.messages) detail = { ...detail, messages: [] };
    scene?.openEntity(null);
    scene?.focusPilot(id);
    scene?.shift(shiftFor());
    void loadDetail();
    void tick().then(() => composer?.focus(true));
  }
  function closePilot(): void {
    const wasDraft = drafting(openPilot);
    openPilot = null; detail = null;
    scene?.focusPilot(null);
    overview();
    if (wasDraft) {
      // back to the feed, on the row it came from
      draft = null; draftText = "";
      unlight();
      void tick().then(() => feedEl?.querySelector(".row.at")?.scrollIntoView({ block: "nearest" }));
    }
  }
  /** Open a feed row's source as a draft desktop: the source beside an empty chat. */
  function openDraft(r: V2SortedRow, path: string): void {
    if (searching) { searching = false; scene?.search(null); }
    ent = null; entRows = null; closeSource();
    cursor = r.source; following = true; draftText = "";
    draft = { row: r, path };
    checkRemote(); delete notes[path];
    const title = r.title ?? r.headline;
    openPilot = `draft:${r.source}`;
    detail = { id: openPilot, title, model: pilotModel, phase: "draft", lifecycle: "active", messages: [],
      desktop: { views: [{ id: "v-source", kind: "note", path, title, at: r.added }], layout: { view: "v-source" }, arrangedBy: null } };
    scene?.hover(null);
    scene?.focusPilot(null);
    scene?.shift(shiftFor());
    void tick().then(() => { scene?.shift(shiftFor()); composer?.focus(true); });
    const held = draft;
    void pilotReq<{ model: string }>("/backend").then((b) => {
      pilotModel = b.model;
      if (draft === held && !held.model && detail) detail = { ...detail, model: b.model };
    }, () => {});
  }
  /** A message you just sent, as the transcript will carry it (under its inputId). */
  const sent = (inputId: string, text: string) => ({ id: inputId, role: "user" as const, text, at: new Date().toISOString() });
  /** The first message keeps a draft desktop: made for real, with its views, and the message sent. */
  async function keepDraft(text: string, inputId: string): Promise<void> {
    const id = openPilot, d = detail, held = draft;
    if (!id || !d || !held) return;
    detail = { ...d, phase: "working", messages: [sent(inputId, text)] };
    try {
      const made = await desktopReq<{ id: string }>("/create", {
        ...(held.titled ? { title: d.title } : {}), ...(held.model ? { model: held.model } : {}),
        context: [{ path: held.path, title: held.row.title ?? held.row.headline }],
        views: (d.desktop?.views ?? []).map((v) => ({ path: v.path, title: v.title })),
      });
      await desktopReq("/send", { id: made.id, text, inputId });
      if (draft === held) draft = null;
      await refreshPilots();
      if (openPilot !== id) return; // you left while it was made: it waits in the bar
      if (hidden[id]) hidden[made.id] = true;
      openPilot = made.id; detail = { ...detail!, id: made.id };
      scene?.focusPilot(made.id);
      void loadDetail();
    } catch (e) {
      if (openPilot === id) { detail = d; draftText = text; }
      flash(`Couldn’t start the desktop: ${errText(e)}`);
    }
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
    if (drafting(id)) return keepDraft(text, inputId);
    // shown now, not after the engine has the agent up: the transcript carries it under the
    // same id (lib/codingDesktops.ts), so the reload below replaces it in place
    const before = detail;
    if (detail?.id === id) detail = { ...detail, messages: [...detail.messages, sent(inputId, text)] };
    try {
      // a coding desktop's agent is steered by what you say while it works
      if (coding(id)) await desktopReq(detail?.phase === "working" ? "/steer" : "/send", { id, text, inputId });
      else await pilotReq("/send", { id, text, inputId });
      await loadDetail();
    }
    catch (e) { if (openPilot === id) { detail = before; draftText = text; } flash(`Couldn’t send: ${errText(e)}`); }
  }
  async function stopPilot(): Promise<void> {
    if (!openPilot) return;
    try { await chatReq(openPilot, "/stop", { id: openPilot }); await loadDetail(); } catch (e) { flash(errText(e)); }
  }
  /** What Land would bring home, shown before anything is pushed: the commits and their diff. */
  type Review = { project: string; branch: string; head: string; commits: Array<{ hash: string; subject: string }>; stat: string; patch: string; cut: boolean };
  let review: Review | null = $state(null);
  $effect(() => { void openPilot; review = null; });
  async function reviewProject(project: string): Promise<void> {
    try { review = await desktopReq<Review>(`/diff?id=${encodeURIComponent(openPilot ?? "")}&project=${encodeURIComponent(project)}`); }
    catch (e) { flash(errText(e)); }
  }
  /** Bring the reviewed commits home, and only those: a PR when the project is on GitHub, else a branch in your copy. */
  async function landProject(r: Review): Promise<void> {
    try {
      const landed = await desktopReq<{ how: "pr" | "branch"; branch: string; url?: string }>("/land", { id: openPilot, project: r.project, head: r.head });
      flash(landed.how === "pr" ? `Opened a pull request: ${landed.url}` : `Brought ${landed.branch} home to ${r.project}. Merge it there when you're ready.`);
      review = null;
      await loadDetail();
    } catch (e) { flash(errText(e)); }
  }
  let discarding: string | null = $state(null);
  async function discardProject(project: string): Promise<void> {
    if (discarding !== project) { discarding = project; flash(`Click Discard again to delete this desktop's copy of ${project}.`); return; }
    discarding = null;
    try { await desktopReq("/discard", { id: openPilot, project }); await loadDetail(); } catch (e) { flash(errText(e)); }
  }
  /** Why a desktop's shell is off, in words: what it started from, then what it read. */
  function taintText(t: NonNullable<PilotDetail["taint"]>): string {
    const started = t.sources.filter((s) => s.via === "start").map((s) => s.title);
    const read = [...new Set(t.sources.filter((s) => s.via !== "start").map((s) => s.title))];
    return [started.length && `started from ${started.join(", ")}`, read.length && `read ${read.join(", ")}`].filter(Boolean).join(" and ");
  }
  /** The person's word that this desktop may use its shell despite what it read; only here, never the agent's. */
  async function allowShell(): Promise<void> {
    try { await desktopReq("/allow-shell", { id: openPilot }); await loadDetail(); } catch (e) { flash(errText(e)); }
  }
  /** The person's answer to a host the agent asked for; the engine passes it on as their message. */
  let answeringHost = $state(false);
  async function answerHost(answer: "desktop" | "all" | "no"): Promise<void> {
    answeringHost = true;
    try { await desktopReq("/answer-host", { id: openPilot, answer }); await loadDetail(); } catch (e) { flash(errText(e)); }
    finally { answeringHost = false; }
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
  /** A citation opens its entity in the field beside the chat, or, when it isn't drawn, the note as a view beside the chat. */
  function citation(e: MouseEvent): void {
    const href = (e.target as Element).closest("a")?.getAttribute("href");
    if (!href?.startsWith(CITE)) return;
    e.preventDefault();
    const path = decodeURIComponent(href.slice(CITE.length));
    const i = field?.nodes.find((n) => n.path === path || n.id === path)?.i;
    if (i != null) void openEntity(i); else void openNote(path);
  }
  async function openNote(path: string): Promise<void> {
    if (!openPilot || data) return;
    try {
      if (coding(openPilot)) await desktopReq("/view", { id: openPilot, action: "open", path });
      else await pilotReq("/desktop", { id: openPilot, action: "open", path });
      hidden[openPilot] = false;
      await loadDetail(); void tick().then(() => scene?.shift(shiftFor()));
    }
    catch (e) { flash(`Couldn’t open the note: ${errText(e)}`); }
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
  /** What the opened entity offers to fold into one (F): its proposal, else its twins. */
  const offer = $derived(field && ent != null && !data ? foldOffer(field, ent, twins, folds, foldsApart) : null);
  let rows = $derived.by(() => (!writing ? [] : claim ? claim.rows : ent != null && entRows ? entRows.slice(-6) : writing.feed.slice(-6)));
  /** `same`: what it may be the same thing as, said where F and X answer it. */
  let hud = $derived.by((): { eyebrow: string; name: string; status: string; writing?: boolean; same?: string; claim?: boolean } | null => {
    if (!field || !writing || searching || openPilot) return null;
    const titled = (r: V2SortedRow) => ({ eyebrow: [r.via, when(r.added)].filter(Boolean).join(" · "), name: r.title ?? r.headline });
    if (src) return { ...titled(src.row), status: src.text ?? "", writing: src.text === "" };
    if (claim) return { eyebrow: [when(claim.row.at), claim.row.by].join(" · "), name: claim.row.text, status: "", claim: true };
    // the row walked to: its source's full title, as an opened source's
    const walked = ent == null ? cursorRow() : null;
    if (walked) return { ...titled(walked), status: "", writing: false };
    if (ent != null) {
      const n = field.nodes[ent]!;
      // a twin you said is a different thing isn't "also" this one
      const apart = (j: number) => foldsApart.some(([a, b]) => (a === n.id && b === field!.nodes[j]!.id) || (b === n.id && a === field!.nodes[j]!.id));
      const tw = (twins.get(ent) ?? []).filter((j) => !apart(j)).map((j) => field!.nodes[j]!.label);
      const who = writersOf(n.id);
      // twins with nothing to answer (a joined vault's, a legacy note) are only named
      const same = !offer && tw.length ? `Also in your vault as “${tw.join("”, “")}”.` : undefined;
      return {
        // where it comes from, when a server has it (0c): connection ids to their names
        eyebrow: [n.memory ? "Memory" : `${n.degree} ${n.degree === 1 ? "tie" : "ties"}`, ...n.servers.map((id) => sharedSettings.connections.find((c) => c.id === id)?.name ?? "").filter(Boolean)].join(" · "), name: n.label,
        status: who.length ? `Lately written about by ${who.join(", ")}.` : "", same,
      };
    }
    return null;
  });

  async function load(): Promise<void> {
    try {
      const [graph, sq] = data ? [data.graph, data.v2] : await Promise.all([api.graph(), api.v2()]);
      writing = sq;
      refreshSorted();
      if (!data) void loadFolds();
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
    const camera = scene?.camera();
    scene?.dispose();
    scene = createV2Scene(host, field, {
      blockers: () => [hudEl, feedEl, searching ? searchEl : undefined, chatEl, sidebarEl].filter((e): e is HTMLElement => !!e).map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0),
      onPick,
      onPickPilot: (id) => (openPilot === id ? closePilot() : openPilotChat(id)),
      onHover: relateTie,
      onPickSource,
      sources: () => graphSources.show,
    }, camera);
    scene.setPilots(placePilots(field, bar));
    sceneRev++;
  }
  /** The vault changed (the engine's /api/events ping, as the app's views
   * hear it): the feed and the record re-read at once; a changed graph is
   * redrawn when nothing is open and no drag is under way, from the camera
   * where you left it, so nothing moves under a hand. */
  let graphStale = false;
  async function onVaultChange(): Promise<void> {
    relations.clear();
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
    if (!graphStale || !heldGraph || ent != null || src || claim || searching || openPilot || scene?.dragging()) return;
    graphStale = false;
    void drawField(heldGraph).then(unlight);
    heldGraph = null;
  }
  /** The feed changes in the background as tend sorts what it files. */
  function refreshSorted(): void {
    if (!data) void api.v2Sorted().then((f) => { sorted = f.rows; }).catch(() => {});
  }
  // pushed, not polled: the base's live stream bumps app.rev when the vault changes
  let pending: ReturnType<typeof setTimeout> | undefined;
  let seenRev = app.rev;
  $effect(() => {
    const rev = app.rev;
    if (data || rev === seenRev) return;
    seenRev = rev;
    clearTimeout(pending); pending = setTimeout(() => void onVaultChange(), 300);
  });
  // the joined servers' names, for what the field says about where a thing comes from
  onMount(() => { if (!data && !selectedWorkspace) void reloadSharedConnections().catch(() => {}); });
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
    return () => { clearInterval(timer); clearTimeout(pending); scene?.dispose(); };
  });

  /** A click in the field: open what's under it; empty space backs out. */
  function onPick(i: number | null): void {
    if (i == null) { if (openPilot) closePilot(); else if ((ent != null || src || claim) && !searching) overview(); return; }
    if (searching) { searching = false; scene?.search(null); }
    if (openPilot) { openPilot = null; detail = null; scene?.focusPilot(null); }
    if (i !== ent) openNode(i);
  }
  /** A node picked (clicked, or chosen in search): an entity that is a
   * source opens the source; any other, itself. */
  function openNode(i: number): void {
    const n = field?.nodes[i];
    if (n?.opens?.length) openSourceAt(n.opens, n.opens[0]!, n.label, [n.id]);
    else void openEntity(i);
  }
  /** A click on a source drawn at rest. */
  function onPickSource(k: number): void {
    const f = field, s = f?.sources[k];
    if (f && s) openSourceAt(s.paths, s.id, s.label, s.ties.map((i) => f.nodes[i]!.id));
  }
  /** A source picked in the field, opened as its feed row is: the row for
   * the first of its paths the feed has; one not in the feed opens the same
   * way, as search's are. */
  function openSourceAt(paths: string[], id: string, label: string, entities: string[]): void {
    if (searching) { searching = false; scene?.search(null); }
    if (openPilot) { openPilot = null; detail = null; scene?.focusPilot(null); }
    openSource(paths.map((p) => sorted.find((r) => r.path === p)).find((r) => r)
      ?? { source: id, section: "know", headline: label, due: null, added: "", entities, title: label, path: paths[0] });
  }
  /** Slide the field's centre clear of the panels: right of a left column, left of the sidebar. */
  const shiftFor = () => {
    const chatW = (chatWidth ?? Math.min(1000, Math.max(520, innerWidth * 0.44))) + GUTTER; // .v2's --chat-w, plus a gutter
    const left = searching ? Math.min(600, innerWidth * 0.4) : openPilot ? chatW : ent != null || src || claim || cursor ? Math.min(380, innerWidth * 0.26) : 0;
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
  function closeSource(): void { if (src || claim) { src = null; claim = null; scene?.search(null); } }
  const feedEntities = (r: { entities: string[] }) => r.entities.map((id) => field!.byId.get(id)).filter((x): x is number => x != null);
  const cursorRow = () => sorted.find((r) => r.source === cursor) ?? null;
  /** The feed row under the pointer: set as the pointer moves, not on enter,
   * so a row the walk scrolls under a resting pointer isn't taken for one pointed at. */
  let rowOver: V2SortedRow | null = $state(null);
  /** The source in hand — a draft's, an opened one, the row under the
   * pointer, else the walk's — drawn in the field while it's held. */
  const sourceInHand = $derived.by((): V2SortedRow | null => {
    if (drafting(openPilot)) return draft?.row ?? null;
    if (openPilot || ent != null) return null;
    if (searching) return recentRow;
    return src?.row ?? rowOver ?? cursorRow();
  });
  $effect(() => {
    void sceneRev;
    const r = sourceInHand;
    // walked to (j/k), it opens as an entity does, its headline beside it;
    // only pointed at, it's named and the camera holds still
    scene?.source(r && field ? { label: r.title ?? r.headline, entities: feedEntities(r), open: !openPilot && !src && r !== rowOver, text: r.headline, path: r.path } : null);
  });
  /** Back from a row pointed at: the row in hand is drawn opened (above), not lit. */
  const unlight = () => scene?.hover(null);
  /** j (down, newer) and k (up, older): the first press takes the newest row;
   * walking up past the top scrolls the older ones in. */
  function stepFeed(dir: 1 | -1): void {
    if (!sorted.length) return;
    if (ent != null || src) overview();
    // a walk starting: Esc comes back to the view it started from
    if (cursor == null) scene?.keepView();
    rowOver = null;
    const at = sorted.findIndex((r) => r.source === cursor);
    cursor = sorted[at < 0 ? 0 : Math.max(0, Math.min(sorted.length - 1, at - dir))]!.source;
    unlight();
    scene?.shift(shiftFor());
    void tick().then(() => feedEl?.querySelector(".row.at")?.scrollIntoView({ block: "nearest" }));
  }
  /** Let go of the walk: the strip settles back on the newest. */
  function leaveFeed(): void {
    cursor = null;
    scene?.hover(null);
    if (!scene?.returnToView()) scene?.overview();
    scene?.shift(shiftFor());
    feedFollowing = true;
    if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  }
  /** Open a feed row's source: its entities lit and framed, the source and
   * Quick's summary of it where an opened entity's name goes. */
  function openSource(r: V2SortedRow): void {
    if (r.lens) return gotoLens(r.lens); // a sharing event opens its lens
    if (r.path && !data) return openDraft(r, r.path);
    if (ent != null) { ent = null; entRows = null; }
    claim = null;
    cursor = r.source;
    rowOver = null;
    src = { row: r, text: r.path && !data ? "" : undefined };
    scene?.hover(null);
    scene?.search({ matches: feedEntities(r), active: null, move: "frame" });
    scene?.shift(shiftFor());
    if (r.path && !data) void briefing(r.path, (text) => { if (src?.row.source === r.source) src = { row: r, text }; })
      .then((ok) => { if (!ok && src?.row.source === r.source && !src.text) src = { row: r }; });
  }
  /** Click an assertion: what it mentions, selected and framed; the claim
   * as the title. Clicked again, it lets go, as Esc does. */
  function openClaim(r: V2FeedRow): void {
    if (claim?.row.id === r.id) { overview(); unlight(); return; }
    const shown = rows;
    if (ent != null) { ent = null; entRows = null; scene?.openEntity(null); }
    src = null;
    claim = { row: r, rows: shown };
    const lit = feedEntities(r);
    scene?.hover(null);
    scene?.search({ matches: lit, active: null, move: lit.length ? "frame" : "none", ties: true });
    scene?.shift(shiftFor());
  }
  // The feed unmounts while a desktop or an entity is open; where you left it
  // is kept here and restored when it comes back. At the newest, it keeps
  // following new rows; scrolled up to read, it stays put — as the chat does.
  let feedFollowing = true, feedTop = 0;
  const onFeedScroll = () => { if (feedEl) { feedTop = feedEl.scrollTop; feedFollowing = feedEl.scrollHeight - feedTop - feedEl.clientHeight < 48; } };
  $effect(() => { if (sorted.length && feedEl) feedEl.scrollTop = feedFollowing && cursor == null ? feedEl.scrollHeight : feedTop; });
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
    const r = searching ? recentRow : ent == null ? cursorRow() : null;
    if (r?.path) return { path: r.path, label: r.title ?? r.headline };
    const i = searching ? activeNode() : ent;
    const n = i == null ? null : field?.nodes[i];
    return n?.path ? { path: n.path, label: n.label } : null;
  }
  /** A pilot on the thing in hand, as the app's lists start one, titled "Re: …". */
  async function startPilot(): Promise<void> {
    const n = inHand();
    if (!n) { flash(`Open something first — ${keyText("start")} starts a Desktop on it.`); return; }
    await createPilot([n.path], `Re: ${n.label}`, [n.label]);
  }
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  const foldLabel = (id: string) => folds.flatMap((g) => g.members).find((m) => m.id === id)?.label
    ?? field?.nodes[field.byId.get(id) ?? -1]?.label ?? id;
  const openId = () => (ent != null && field ? field.nodes[ent]!.id : null);
  /** Accept `from` → the keeper: it becomes an alias of the keeper. */
  const acceptMerge = (from: string) => { if (offer) void settleFold(api.acceptFold(offer.keep, [from]), from === openId() ? offer.keep : openId()); };
  /** A fold written (the accept route makes each folded name an alias of the
   * kept one): draw the field anew, opened on the one that stands. */
  async function settleFold(act: ReturnType<typeof api.acceptFold>, land: string | null): Promise<void> {
    if (folding) return;
    folding = true;
    try {
      const done = await act;
      await loadFolds();
      const graph = await api.graph();
      ent = null; entRows = null;
      await drawField(graph);
      // back on the page you were on, unless it was the one folded away
      const i = field?.byId.get(land ?? done.canonical.id) ?? field?.byId.get(done.canonical.id);
      if (i != null) void openEntity(i);
      flash(`Folded ${done.aliased.map((a) => `“${a.label}”`).join(", ")} into “${done.canonical.label}”.`);
    } catch (e) { flash(`Couldn’t fold: ${errText(e)}`); }
    finally { folding = false; }
  }
  async function loadFolds(): Promise<void> {
    try { const f = await api.folds(); folds = f.groups; foldsApart = f.rejected ?? []; } catch { /* no folds door: nothing offered */ }
  }
  /** Reject `from` → the keeper: two things — remembered (the fold log),
   * never offered together again. */
  async function rejectMerge(from: string): Promise<void> {
    const keep = offer?.keep;
    if (!keep || folding) return;
    folding = true;
    try {
      await api.rejectFold(from, [keep]);
      await loadFolds();
      flash(`Kept “${foldLabel(from)}” apart from “${foldLabel(keep)}”.`);
    } catch (e) { flash(`Couldn’t keep them apart: ${errText(e)}`); }
    finally { folding = false; }
  }
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
  /** How a hovered tie relates to the opened entity, in Quick's words beside
   * the tie's name. It is asked for once the pointer settles, so passing over
   * a tie doesn't ask; a pair already told is shown at once. */
  const relations = new Map<string, string>();
  let relateTimer: ReturnType<typeof setTimeout> | undefined;
  let relating: number | null = null;
  function relateTie(j: number | null): void {
    clearTimeout(relateTimer);
    const i = ent, focus = i == null ? undefined : field?.nodes[i]?.path, hovered = j == null ? undefined : field?.nodes[j]?.path;
    if (data || i == null || j == null || j === i || !focus || !hovered || !neighbours(field!, i).includes(j)) {
      if (relating != null) { relating = null; scene?.relate(null); }
      return;
    }
    relating = j;
    const pair = JSON.stringify([focus, hovered]);
    const known = relations.get(pair);
    if (known) { scene?.relate(j, known); return; }
    scene?.relate(null);
    const still = () => ent === i && relating === j;
    relateTimer = setTimeout(() => {
      if (!still()) return;
      scene?.relate(j, "");
      void fetch("/api/note/relation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ focus, hovered }) })
        .then(async (r) => { const body = await r.json() as { relation?: { text: string } }; if (!r.ok || !body.relation) throw new Error(); return plain(body.relation.text); })
        .then((text) => { relations.set(pair, text); if (still()) scene?.relate(j, text); })
        // no relation to give: the tie keeps its plain name
        .catch(() => { if (still()) scene?.relate(null); });
    }, 300);
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
  /** Before you type, the search lists what the @ menu does: the items most
   * recently added (lib/mentionSources.ts), newest first. Each is gone to as
   * what it is in the field: a thing there is glided to as a match is, a
   * source as a walked feed row is, over what it mentions. A source the feed
   * doesn't hold mentions nothing here: it sits where you are. */
  const recentShown = $derived(searching && !query.trim() ? mentionRecentItems : []);
  /** Typed, the field's names come first (nine at most), then `found`: what
   * answers by title — the field's sources and the recents in hand at once —
   * and the vault's own search (/api/search, as the @ menu has it: older
   * sources, a joined vault's, a match in the text) once it answers. A
   * source isn't an entity, so the names alone never find one. */
  const named = $derived(matches.slice(0, 9));
  const fieldSources = $derived(field ? sourceItems(field) : []);
  /** The vault search's last answer, and the query it answered. */
  let vaultHits: { q: string; items: MentionItem[] } = $state({ q: "", items: [] });
  /** The vault's search is out for the query: "nothing" waits for it. */
  let finding = $state(false);
  let findTimer: ReturnType<typeof setTimeout> | undefined;
  let findAbort: AbortController | undefined;
  const found = $derived.by(() => {
    const q = query.trim();
    if (!searching || !field || !q) return [];
    // an answer to an earlier query keeps what still answers by title, so the list doesn't blink as you type
    const fresh = vaultHits.q === q;
    return searchFound(field, q, matches, [...fieldSources, ...mentionRecentItems, ...(fresh ? [] : vaultHits.items)], fresh ? vaultHits.items : []);
  });
  /** What's listed below the names: the recents, or what the typed search found. */
  const items = (): MentionItem[] => (query.trim() ? found : recentShown);
  const itemAt = (k: number): MentionItem | undefined => (k < named.length ? undefined : items()[k - named.length]);
  const rowCount = () => named.length + items().length;
  const nodeAt = $derived.by(() => {
    const at = new Map<string, number>();
    for (const n of (field as Field | null)?.nodes ?? []) if (n.path) at.set(n.path, n.i);
    return at;
  });
  /** The source in hand (a recent, or one found), drawn in the field as the walk's row is. */
  let recentRow: V2SortedRow | null = $state(null);
  const rowFor = (m: MentionItem): V2SortedRow => sorted.find((r) => r.path === m.id)
    ?? { source: m.id, section: "know", headline: m.title, due: null, added: "", title: m.title, path: m.id,
      // one the field draws mentions what its ties are
      entities: field?.sources.find((s) => s.paths.includes(m.id))?.ties.map((i) => field!.nodes[i]!.id) ?? [] };
  /** What the search lights: its matches, and the items listed that are things in the field. */
  const lit = (): number[] => [...matches, ...items().flatMap((m) => { const i = nodeAt.get(m.id); return i == null ? [] : [i]; })];
  /** Row `k` as a thing in the field: a name, or an item the field draws. */
  const nodeOf = (k: number): number | null => {
    if (k < named.length) return named[k]!;
    const m = itemAt(k);
    return m ? nodeAt.get(m.id) ?? null : null;
  };
  const activeNode = () => nodeOf(active);
  /** The row in hand, in the field: a thing there is glided to, a source drawn as a walked feed row is. */
  function showActive(): void {
    const m = itemAt(active), i = activeNode();
    recentRow = m && i == null ? rowFor(m) : null;
    if (i != null) scene?.search({ matches: lit(), active: i, move: "glide" });
    else scene?.search({ matches: recentRow ? feedEntities(recentRow) : [], active: null, move: "none" });
  }
  function openSearch(): void {
    searching = true; query = ""; matches = []; active = 0; recentRow = null; claim = null; vaultHits = { q: "", items: [] };
    if (!data) loadMentionRecents();
    showActive();
    sayActive();
    scene?.shift(shiftFor());
    void tick().then(() => qEl?.focus());
  }
  function stopFind(): void {
    clearTimeout(findTimer);
    findAbort?.abort();
    finding = false;
  }
  function closeSearch(): void {
    searching = false; recentRow = null;
    stopFind();
    clearTimeout(sayTimer);
    scene?.search(null);
    scene?.shift(shiftFor());
    if (ent != null) void openEntity(ent); else scene?.overview();
  }
  function runQuery(): void {
    if (!field) return;
    active = 0;
    stopFind();
    const q = query.trim();
    if (!q) { matches = []; showActive(); sayActive(); return; }
    recentRow = null;
    matches = searchNames(field, query);
    if (matches.length || !found.length) scene?.search({ matches: lit(), active: matches[0] ?? null, move: "frame" });
    else showActive();
    sayActive();
    if (!data) find(q);
  }
  /** The vault's search for `q` once the keys settle; what it finds joins the list below the names. */
  function find(q: string): void {
    finding = true;
    const ctl = (findAbort = new AbortController());
    findTimer = setTimeout(async () => {
      // a search that fails finds nothing
      const items = await mentionSearch(q, ctl.signal).catch((): MentionItem[] => []);
      if (ctl.signal.aborted || !searching || query.trim() !== q) return;
      vaultHits = { q, items };
      finding = false;
      // the rows below the names are new: the one in hand is shown again
      if (active >= named.length) { active = Math.min(active, Math.max(0, rowCount() - 1)); showActive(); sayActive(); }
    }, 120);
  }
  function setActive(k: number): void {
    const n = rowCount();
    if (!n) return;
    if (query.trim()) active = (k + n) % n;
    else {
      // the recents run on: no wrapping round, and near their end the next page comes
      active = Math.max(0, Math.min(n - 1, k));
      if (active >= n - 3) loadMentionRecents(true);
    }
    showActive();
    void tick().then(() => searchEl?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
    sayActive();
  }
  let sayTimer: ReturnType<typeof setTimeout> | undefined;
  /** The active match's summary, as a clicked node has it: a spinner, then
   * Quick's words as they arrive. It starts once the arrow keys settle, so
   * passing over a match doesn't ask for one. The camera holds still. */
  function sayActive(): void {
    clearTimeout(sayTimer);
    const i = activeNode();
    if (i == null) return;
    const path = data ? undefined : field!.nodes[i]!.path;
    const show = (text?: string) => { if (searching && activeNode() === i) scene?.search({ matches: lit(), active: i, text, move: "none" }); };
    if (!path) return show();
    show("");
    sayTimer = setTimeout(() => void briefing(path, show).then((ok) => { if (!ok) show(); }), 350);
  }
  function commit(k = active): void {
    const m = itemAt(k), i = nodeOf(k);
    if (i == null && !m) return;
    searching = false; recentRow = null;
    stopFind();
    scene?.search(null);
    if (i != null) openNode(i); else openSource(rowFor(m!));
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

  /** Esc in the field: let go of any selection, then back out of the
   * innermost thing open — the agent picker, the Desktop, the entity or
   * source, the feed walk. False when there was nothing to back out of. */
  function back(): boolean {
    getSelection()?.removeAllRanges();
    if (pickerOpen) pickerOpen = false;
    else if (openPilot) closePilot();
    else if (ent != null || src || claim) { overview(); unlight(); }
    else if (cursor) leaveFeed();
    else return false;
    return true;
  }
  /** "⌘O Open": a shortcut's key and what it does, or nothing when hints are
   * off or nothing answers the key. */
  const hint = (id: string, what: string) => keyboardHints.show && keyText(id) ? `${keyText(id)} ${what}` : "";

  // This view's keys, registered while it's mounted: lib/shortcuts.svelte.ts
  // dispatches them and lists them on the ? sheet.
  onMount(() => {
    const offs = [
      registerShortcuts({ title: "Field", rank: RANK.field, when: () => !paused, shortcuts: [
        { id: "search", label: "Search", keys: [{ key: "/" }], when: () => !!field, run: openSearch },
        { id: "feed", label: "Step through the feed", keys: [{ key: ["j", "k"] }], when: () => !!field, run: (e) => stepFeed(e.key === "j" ? 1 : -1) },
        { id: "open", label: "Open the selected row", keys: [{ key: "Enter", shift: false }], when: () => !!cursor && ent == null && !!cursorRow(), run: () => openSource(cursorRow()!) },
        { id: "start", label: "Start a Desktop on what’s open", keys: [{ key: "Enter", shift: true }], when: () => !!field, run: () => void startPilot() },
        { id: "desktops", label: "Open or close a Desktop", keys: [{ key: ["1", "2", "3", "4", "5", "6", "7", "8", "9"], label: "1–9" }], run: (e) => {
          const p = bar[Number(e.key) - 1];
          if (!p) return false;
          if (openPilot === p.id) closePilot(); else openPilotChat(p.id);
        } },
        { id: "new", label: "New Desktop", keys: [{ key: "n", mod: true, shift: false }, { key: "n" }], when: () => !!field, run: () => void createPilot([]) },
        { id: "views", label: "Show or hide the Desktop’s views", keys: [{ key: "\\" }], when: () => !!openPilot, run: toggleDesktop },
        { id: "original", label: "Open the original source", keys: [{ key: "o", mod: true, shift: false }], when: () => !!original(), run: () => void openOriginal(original()!) },
        { id: "back", label: "Back", keys: [{ key: "Escape", shift: false }], run: back },
        // from the message box too, where an open Desktop's keys usually are
        { id: "archive", label: "Archive the Desktop", keys: [{ key: "Escape", shift: true, typing: true }], when: () => !!openPilot && !drafting(openPilot), run: () => void archiveDesktop() },
        // ⌘, (Ctrl+, elsewhere): the same view the app's gear opens
        { id: "settings", label: "Settings", keys: [{ key: ",", mod: true }], run: openSettings },
        { id: "shortcuts", label: "Shortcuts", keys: [{ key: "?" }], run: () => { shortcutsOpen = true; } },
      ] }),
      // typing in the search box is the box's: these, and the characters land
      registerShortcuts({ title: "Search", rank: RANK.input, when: () => !paused && searching, input: () => qEl, shortcuts: [
        { id: "search-move", label: "Move through results", keys: [{ key: ["ArrowUp", "ArrowDown"] }], run: (e) => setActive(active + (e.key === "ArrowDown" ? 1 : -1)) },
        { id: "search-open", label: "Open the result", keys: [{ key: "Enter", shift: false }], run: () => commit() },
        { id: "search-start", label: "Start a Desktop on the result", keys: [{ key: "Enter", shift: true }], run: () => void startPilot() },
        { id: "search-close", label: "Close search", keys: [{ key: "Escape" }], run: closeSearch },
      ] }),
      // an Esc the composer's @ menu let through leaves the composer
      registerShortcuts({ title: "Message box", rank: RANK.input, when: () => !paused, input: () => composerEl, shortcuts: [
        { id: "composer-leave", label: "Leave the message box", keys: [{ key: "Escape", shift: false }], run: () => { if (drafting(openPilot) && !draftText.trim()) closePilot(); else composer?.blur(); } },
      ] }),
    ];
    return () => offs.forEach((off) => off());
  });
</script>

{#snippet tile(t: DesktopTile)}
  {#if "view" in t}
    {@const v = desktopViews.find((x) => x.id === t.view)}
    {#if v}
      {@const srcMeta = v.kind === "note" ? notes[v.path]?.source : undefined}
      <article class="view" aria-label={v.title}>
        <header><span class="vt">{v.title}</span>{#if v.kind === "url"}<a class="vp" href={otherLoopback(v.path)} target="_blank" rel="noopener" title="Open in a browser">{v.path} ↗</a>{:else if srcMeta}<span class="vp" title={v.path}>{srcMeta.via[0]!.toUpperCase() + srcMeta.via.slice(1)}{srcMeta.date ? ` · ${when(srcMeta.date)}` : ""}{srcMeta.page ? ` · read from ${srcMeta.page}` : ""}</span>{:else if v.kind === "note"}<span class="vp">{v.path}</span>{:else}<span class="vp"></span>{/if}
          <button type="button" class="px" onclick={() => void closeView(v.id)} aria-label={`Close ${v.title}`} title="Close — the agent leaves it closed">×</button></header>
        {#if v.kind === "html"}
          <!-- the agent's page, in this person's theme; scripts don't run -->
          <iframe class="vpage vhtml" sandbox="" title={v.title} srcdoc={pageDoc(v.html ?? "", pageVars)}></iframe>
        {:else if v.kind === "url"}
          <!-- a page on this machine (the engine's CSP allows nothing else), under
               the other loopback name so it is sent none of the viewer's cookies. Its own
               referrer policy: WebKit would otherwise hand it the viewer's no-referrer, and
               its theme-sheet requests, cross-site with no Referer, are refused (lib/httpx.ts) -->
          {#key v.at}<iframe class="vpage" src={otherLoopback(v.path)} title={v.title} referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"></iframe>{/key}
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="vbody" onclick={(e) => loadHeld(e) || citation(e)}>
            {#if srcMeta}
              <div class="vsum">{#if srcMeta.summary}{srcMeta.summary}{:else}<span class="spin" aria-label="Writing a summary"></span>{/if}</div>
              {#if srcMeta.header.length}<dl class="vhead">{#each srcMeta.header as [k, val] (k)}<dt>{k}</dt><dd>{val}</dd>{/each}</dl>{/if}
            {/if}
            {#if srcMeta}<div class="vsrc">{@html srcMeta.html}</div>
            {:else if notes[v.path]?.content != null}{@html render(notes[v.path]!.content!)}
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

<div class="v2" bind:this={rootEl} style:--chat-w={chatWidth ? `${chatWidth}px` : null}>
  <div class="stage" bind:this={host}></div>

  {#if field}
    <nav class="strip" aria-label="Pilots">
      <!-- the task's full name is the token: no model squeezed in beside it -->
      {#each bar as p, k (p.id)}
        <span class="tokwrap">
          <button type="button" class="tok" class:on={openPilot === p.id} class:working={p.phase === "working"} aria-pressed={openPilot === p.id}
            title={`${p.title} · ${p.model} · ${PHASE[p.phase]} (${k + 1})`} onclick={() => (openPilot === p.id ? closePilot() : openPilotChat(p.id))}>
            <DesktopCube id={p.id} working={p.phase === "working"} />
            <span class="k">{k + 1}</span><span class="t">{p.title}</span>
          </button>
          <button type="button" class="tokx" class:on={openPilot === p.id} onclick={() => void closeDesktop(p.id)}
            aria-label={`Close ${p.title}`} title="Close this desktop: its processes stop; its conversation is kept">×</button>
        </span>
      {/each}
      <button type="button" class="new" onclick={() => void createPilot([])} title={`New Desktop ${keyText("new") && `(${keyText("new")})`}`}>+ <span class="k keyboard-hint">{keyText("new")}</span></button>
      <button type="button" class="find" onclick={openSearch}>Search <span class="k keyboard-hint">{keyText("search")}</span></button>
      <button type="button" class="gear" onclick={openSettings} title={`Settings ${keyText("settings") && `(${keyText("settings")})`}`} aria-label="Settings">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </nav>
  {/if}

  {#if hud}
    <header class="hud" class:claim={hud.claim} bind:this={hudEl}>
      <span class="eyebrow">{[hud.eyebrow, original() && hint("original", "Open")].filter(Boolean).join(" · ")}</span>
      <h1>{hud.name}</h1>
      {#if hud.writing}<p><span class="spin" aria-label="Writing a summary"></span></p>{:else if hud.status}<p>{hud.status}</p>{/if}
      {#if hud.same}<p>{hud.same}</p>{/if}
      {#if ent != null && offer}
        <!-- the merge, the same on every page it touches -->
        <div class="same" role="group" aria-label="Merge?">
          <span class="same-head">Merge?</span>
          {#if offer.why}<p class="same-why">{offer.why}</p>{/if}
          {#each offer.rows as from (from)}
            <div class="cand">
              <span class="cand-name">{foldLabel(from)} <span class="arrow">→</span> {foldLabel(offer.keep)}</span>
              {#if !folding}
                <span class="acts">
                  <button type="button" onclick={() => acceptMerge(from)}>Accept</button>
                  <button type="button" onclick={() => void rejectMerge(from)}>Reject</button>
                </span>
              {/if}
            </div>
          {/each}
          {#if folding}<span class="busy">Saving…</span>{/if}
        </div>
      {/if}
    </header>
  {/if}

  {#if searching && field}
    <div class="search" bind:this={searchEl} role="dialog" aria-label="Search by name">
      <div class="field">
        <input bind:this={qEl} bind:value={query} oninput={() => runQuery()} placeholder="Find anything by name…" aria-label="Find by name" autocomplete="off" spellcheck="false" />
        <span class="k keyboard-hint">{keyText("search-close")}</span>
      </div>
      {#snippet itemRow(m: MentionItem, k: number)}
        {@const i = nodeAt.get(m.id)}
        {@const parts = marked(m.title)}
        <li role="option" aria-selected={k === active} onpointermove={() => { if (k !== active) setActive(k); }} onclick={() => commit(k)} onkeydown={() => {}}>
          <span class="dot" class:src={i == null} style:--r={`${2.2 + Math.min(3.6, Math.log1p(i == null ? 0 : field!.nodes[i]!.degree) * 0.62)}px`}></span>
          <span class="ttl">{parts[0]}<mark>{parts[1]}</mark>{parts[2]}</span>
          <span class="meta">{[m.tag[0] + m.tag.slice(1).toLowerCase(), m.date].filter(Boolean).join(" · ")}</span>
        </li>
      {/snippet}
      {#if query.trim()}
        {#if !named.length && !found.length && !finding}<p class="none">Nothing in your vault is called “{query.trim()}”.</p>{/if}
        <ul role="listbox" aria-label="Matches">
          {#each named as i, k (i)}
            {@const parts = marked(field.nodes[i]!.label)}
            <li role="option" aria-selected={k === active} onmouseenter={() => setActive(k)} onclick={() => commit(k)} onkeydown={() => {}}>
              <span class="dot" style:--r={`${2.2 + Math.min(3.6, Math.log1p(field.nodes[i]!.degree) * 0.62)}px`}></span>
              <span class="ttl">{parts[0]}<mark>{parts[1]}</mark>{parts[2]}</span>
              <span class="meta">{metaOf(i)}</span>
            </li>
          {/each}
          {#each found as m, k (m.id)}{@render itemRow(m, named.length + k)}{/each}
        </ul>
      {:else}
        {#if recentShown.length}
          <ul role="listbox" aria-label="Recently added" onscroll={(e) => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) loadMentionRecents(true); }}>
            {#each recentShown as m, k (m.id)}{@render itemRow(m, k)}{/each}
          </ul>
        {:else}
          <!-- nothing while they load: the box is the search until they come -->
          {#if !mentionRecentLoading}<p class="none">{mentionRecentError ? "Couldn’t load recents. Type to search." : "Nothing added yet."}</p>{/if}
        {/if}
      {/if}
    </div>
  {/if}

  {#if sorted.length && ent == null && !openPilot}
    <div class="feed sorted" class:walking={cursor} bind:this={feedEl} onscroll={onFeedScroll} aria-label="Your feed">
      {#each sortedShown as r (r.source)}
        <div class="row s-{r.section}" class:at={r.source === cursor} class:open={r.source === src?.row.source} role="button" tabindex="-1"
          title={r.title && r.title !== r.headline ? r.title : undefined}
          onmousemove={() => { if (rowOver !== r) { rowOver = r; if (!src) scene?.hover(feedEntities(r)); } }}
          onmouseleave={() => { rowOver = null; if (!src) unlight(); }}
          onclick={() => openSource(r)} onkeydown={() => {}}>
          <span class="w" title="When it entered your feed">{when(r.added)}</span>
          <span class="x">{r.headline}{#if r.due}<span class="due">{dueOn(r.due)}</span>{/if}</span>
        </div>
      {/each}
    </div>
  {:else if rows.length && !openPilot}
    <div class="feed" bind:this={feedEl} onscroll={onFeedScroll} aria-label="Latest assertions">
      {#each rows as r (r.id)}
        <div class="row" class:open={r.id === claim?.row.id} role="button" tabindex="-1"
          onmouseenter={() => scene?.hover(feedEntities(r))}
          onmouseleave={() => scene?.hover(null)}
          onclick={() => openClaim(r)} onkeydown={() => {}}>
          <span class="w" title={r.writtenAt ? `First recorded ${when(r.at)}; this version written ${when(r.writtenAt)}` : undefined}>{when(r.at)}</span>
          <span class="a" class:client={!r.model} title={r.model ? (r.author === "gardener" ? `Filed by the gardener on ${r.by}` : `Written by ${r.by}`) : r.author ? `Written through ${authorName(r.author)}; the model it ran isn’t recorded` : "Written by you"}>{r.by}</span>
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
          {#if desktopViews.length}<button type="button" class="find" class:lit={showDesktop} onclick={toggleDesktop} title={`Show or hide this desktop's views ${keyText("views") && `(${keyText("views")})`}`}>{desktopViews.length} {desktopViews.length === 1 ? "view" : "views"} <span class="k keyboard-hint">{keyText("views")}</span></button>{/if}
        </div>
        {#if detail.contextNodes?.length}<p class="ctx">{detail.contextNodes.map((n) => n.title ?? n.id).join(" · ")}</p>{/if}
        {#if detail.changes?.length}
          <div class="forks">
            {#each detail.changes as c (c.project)}
              <span class="fork"><b>{c.project}</b> {c.commits} commit{c.commits === 1 ? "" : "s"}{c.dirty ? ` · ${c.dirty} uncommitted` : ""}
                <button type="button" class="find" onclick={() => void reviewProject(c.project)} disabled={!c.commits || c.dirty > 0}
                  title={c.dirty ? "Commit the changes first; landing moves commits" : c.commits ? "Review its commits, then land them: a pull request when the project is on GitHub, otherwise a branch in your copy" : "Nothing committed yet"}>Land…</button>
                <button type="button" class="find" class:lit={discarding === c.project} onclick={() => void discardProject(c.project)} title="Delete this desktop's copy">Discard</button></span>
            {/each}
          </div>
        {/if}
        {#if review && detail.changes?.some((c) => c.project === review?.project)}
          <div class="review" aria-label={`Changes to land in ${review.project}`}>
            <p><b>{review.project}</b> · {review.commits.length} commit{review.commits.length === 1 ? "" : "s"} on {review.branch}</p>
            <ul>{#each review.commits as c (c.hash)}<li><code>{c.hash}</code> {c.subject}</li>{/each}</ul>
            <pre>{review.patch}{review.cut ? "\n… (the rest is cut here; read it in the worktree)" : ""}</pre>
            <span><button type="button" class="find" onclick={() => review && void landProject(review)}>Land these commits</button>
              <button type="button" class="find" onclick={() => { review = null; }}>Cancel</button></span>
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
        {#if detail.taint?.refused}
          <div class="ask" role="group" aria-label="The shell is off for this desktop">
            <p class="ask-head">The shell is off for this desktop</p>
            <p>It {taintText(detail.taint)}, so its commands wait for you. Allowed, they run in a sandbox: they change only its own copies of your projects and reach only allowlisted hosts.</p>
            <code>{detail.taint.refused.command}</code>
            <span><button type="button" class="allow" onclick={() => void allowShell()}>Allow shell</button></span>
          </div>
        {/if}
        {#if detail.hostRequest}
          <div class="ask" role="group" aria-label="This desktop asks to reach a site">
            <p class="ask-head">This desktop asks to reach a site</p>
            <code>{detail.hostRequest.host}</code>
            {#if detail.hostRequest.reason}<p>In its words: {detail.hostRequest.reason}</p>{/if}
            <p>{detail.hostRequest.untrusted ? "It has read content from outside you, so allow only a site you know. " : ""}Allowed, its commands can reach this site; nothing else changes.</p>
            <span class="ask-actions">
              <button type="button" class="allow" disabled={answeringHost} onclick={() => void answerHost("desktop")}>Allow for this desktop</button>
              <button type="button" class="find" disabled={answeringHost} onclick={() => void answerHost("all")}>Allow for all desktops</button>
              <button type="button" class="find" disabled={answeringHost} onclick={() => void answerHost("no")}>Don’t allow</button>
            </span>
          </div>
        {/if}
        {#if !detail.messages.length && detail.phase === "draft"}<p class="activity">{coding(detail.id) || drafting(detail.id) ? "Ask it anything: it can read your vault and work on your projects." : "Ask it anything — it can read your vault."}</p>{/if}
      </div></div>
      <div class="dock" style:--gutter={`${gutter}px`}><div class="composer col">
        <div class="input" bind:this={composerEl} onfocusin={() => { if (!mentionRecentItems.length && !mentionRecentLoading) loadMentionRecents(); }}>
          {#key detail.id}
            <PilotMentionComposer bind:this={composer} ariaLabel="Message" currentId={detail.id} value={draftText} autofocus={false}
              recents={mentionRecentItems} recentLoading={mentionRecentLoading} recentError={mentionRecentError} onmore={() => loadMentionRecents(true)} search={mentionSearch}
              onchange={(parts) => { draftText = serializeMentions(parts); }} onsend={() => void sendDraft()}
              placeholder={`Message ${detail.title}… type @ to mention`} />
          {/key}
        </div>
        <div class="row">
          <span class="k">{[hint("composer-send", coding(detail.id) && detail.phase === "working" ? "Steer" : "Send"), hint("composer-newline", "New line"), hint("composer-leave", "Back")].filter(Boolean).join(" · ")}</span>
          {#if detail.phase === "working"}<button type="button" class="find" onclick={() => void stopPilot()}>Stop</button>{/if}
          {#if drafting(detail.id)}<span class="k">{["Not kept until you send", original() && hint("original", "Open original")].filter(Boolean).join(" · ")}</span>
          {:else if coding(detail.id)}<button type="button" class="find" onclick={() => void archiveDesktop()} title={`Stop its processes; its files and conversation stay ${keyText("archive") && `(${keyText("archive")})`}`}>Archive</button>{/if}
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
      <p class="k">{[hint("back", "to close"), "the next reply comes from the one you pick"].filter(Boolean).join(" · ")}</p>
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

  {#if keyboardHints.show}<button type="button" class="hints" onclick={() => (shortcutsOpen = true)} aria-haspopup="dialog"><kbd>{keyText("shortcuts")}</kbd> Shortcuts</button>{/if}
  <ShortcutsSheet bind:open={shortcutsOpen} />
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if error}<p class="error">The v2 view couldn’t load: {error}</p>{/if}
  {#if field && !field.nodes.length && !openPilot}
    <!-- a new vault: nothing drawn yet, so say how things arrive -->
    <div class="empty">
      <h1>Nothing here yet</h1>
      <p>Drop a file or a link anywhere on this window, or connect your mail, meetings or feeds. What arrives is filed into your vault and shows up here.</p>
      {#if !data}<button type="button" class="find" onclick={() => goto("integrations")}>Connect an integration</button>{/if}
    </div>
  {/if}
</div>

<style>
  .v2 { --chat-w: clamp(520px, 44vw, 1000px);
    /* the chat as drawn: your width (or the default), kept left of the
       notification stack's column while a notice shows */
    --chat-at: min(var(--chat-w), 100vw - var(--notice-lane, 0px) - 3 * var(--app-gutter, 34px));
    /* where what opens under the top bar starts: below the bar, or in a
       narrow window below the notification stack (its --notice-band) */
    --under-bar: max(62px, var(--notice-band, 0px));
    --font-app: "IBM Plex Sans", system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, monospace;
    --v2-muted: color-mix(in srgb, var(--fg) 65%, var(--bg));
    --v2-faint: color-mix(in srgb, var(--fg) 45%, var(--bg));
    /* the room below the strips over the top bar (FieldView) */
    position: absolute; inset: 0; background: var(--bg);
    font-family: var(--font-app); color: var(--fg); overflow: hidden;
    /* the field is a picture, not a page: neither a drag across its names nor
       ⌘A may paint a selection over it. What's there to read — a chat, the
       desktop, the opened thing's summary, anything typed — selects as usual.
       (WebKit, the desktop app's, needs the prefix.) */
    -webkit-user-select: none; user-select: none;
  }
  .chat, .side, .hud, .v2 :global(input), .v2 :global(textarea) { -webkit-user-select: text; user-select: text; }
  .stage { position: absolute; inset: 0; }
  .stage :global(.v2-canvas) { display: block; width: 100%; height: 100%; touch-action: none; }
  .stage :global(.v2-labels) { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .stage :global(.v2-lab) { position: absolute; left: 0; top: 0; white-space: nowrap; will-change: transform, opacity; pointer-events: auto; cursor: pointer;
    text-shadow: 0 0 3px var(--bg), 0 0 8px var(--bg), 0 0 16px var(--bg); }
  .stage :global(.v2-node .t) { font: 400 11px/1.2 var(--font-mono); letter-spacing: -0.01em; color: var(--v2-muted); }
  .stage :global(.v2-node:hover .t) { color: var(--fg); }
  /* Desktop names in the sans, a size up from the mono names of the field */
  .stage :global(.v2-pilot) { font: 500 12px/1 var(--font-app); color: var(--v2-muted); }
  .stage :global(.v2-pilot:hover) { color: var(--fg); }
  .stage :global(.v2-source) { pointer-events: none; }
  .stage :global(.v2-pilot.working) { color: color-mix(in srgb, var(--activity) 80%, var(--fg)); }
  .stage :global(.v2-node.memory .t) { font: 500 12px/1.2 var(--font-app); color: var(--fg); }
  .stage :global(.v2-node .q), .stage :global(.v2-node .c) { display: none; }
  .stage :global(.v2-node.full .c:not(:empty)) { display: block; margin-bottom: 6px; font: 600 9px/1 var(--font-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--v2-faint); }
  .stage :global(.v2-node.full .t) { display: none; }
  .stage :global(.v2-node.full .q) { display: block; white-space: normal; width: max-content; max-width: 32ch;
    font: 400 13px/1.45 var(--font-app); color: color-mix(in srgb, var(--fg) 82%, var(--bg)); }
  .stage :global(.v2-node .q b) { font-weight: 600; color: var(--fg); }
  .stage :global(.v2-node .q .spin), .hud .spin, .vsum .spin { display: inline-block; width: 9px; height: 9px; margin-left: 9px; vertical-align: -1px; border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, var(--fg) 22%, transparent); border-top-color: var(--fg); animation: v2spin .8s linear infinite; }
  @keyframes v2spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .stage :global(.v2-node .q .spin), .hud .spin, .vsum .spin { animation-duration: 2.4s; } }

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
  /* the cube's glass sits on the token's own ground */
  .tok { --cube-ground: var(--bg); }
  .tok:hover { --cube-ground: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  .tok.on { --cube-ground: var(--fg); }
  .tok:hover, .new:hover { background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  /* the × sits over the token's right end, shown on hover or keyboard focus */
  .tokwrap { position: relative; display: inline-flex; }
  /* a narrow bar shortens the names rather than drawing them over + and Search */
  .tokwrap > .tok { min-width: 0; }
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
  /* What sits under the top bar leaves the notification stack its corner
     (NotificationStack.svelte): it starts at --under-bar, --notice-lane keeps
     the chat (--chat-at) and the empty state left of the stack's column, and
     --notice-foot starts a desktop's views below the stack. The lane holds
     with Settings closed too, on purpose: the field's own chat and empty
     state have controls there. */
  /* the chat sits on the ground itself: opaque, fading into the field at its right edge */
  .chat { container-type: inline-size;
    position: absolute; top: 0; bottom: 0; left: 0; width: calc(var(--chat-at) + var(--app-gutter, 34px)); padding: calc(var(--under-bar) + 10px) 0 26px var(--app-gutter, 34px); box-sizing: border-box;
    display: flex; flex-direction: column; gap: 10px; background: var(--bg); z-index: 1; }
  .chat::after { content: ""; position: absolute; top: 0; bottom: 0; right: -96px; width: 96px; pointer-events: none;
    background: linear-gradient(to right, var(--bg), color-mix(in srgb, var(--bg) 0%, transparent)); }
  /* with no views the chat stands alone, centred, fading into the field on both sides */
  .chat.solo { left: calc((100% - var(--notice-lane, 0px)) / 2); transform: translateX(-50%); padding-right: var(--app-gutter, 34px); width: calc(var(--chat-at) + 2 * var(--app-gutter, 34px)); }
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
  /* it scrolls within the field, above the field's 26px foot: below the
     notices in a short window there is little room left */
  .picker { position: absolute; z-index: 6; top: calc(var(--under-bar) + 48px); left: var(--app-gutter, 34px); width: min(420px, calc(100% - 68px)); max-height: min(70vh, calc(100% - var(--under-bar) - 74px)); overflow-y: auto; padding: 16px;
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
  /* the scrollbar's gutter is kept on both sides of the messages, and the
     composer's dock is padded by the same (--gutter, measured off .msgs): the
     two columns centre in the same width and line up. The dock can't take the
     gutter itself — that needs overflow hidden, which would clip the @ menu.
     The column leaves 12px a side for the composer box to reach into */
  .msgs { scrollbar-gutter: stable both-edges; scrollbar-width: thin; }
  .msgs { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
    scrollbar-color: color-mix(in srgb, var(--fg) 22%, transparent) transparent; }
  .dock { flex: none; padding-inline: var(--gutter, 0px); }
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
  .composer .input { margin-inline: -12px; position: relative; }
  .composer .input :global(.editor) { -webkit-user-select: text; user-select: text; min-height: calc(3 * 1.45em + 18px); padding: 9px 12px; border-radius: 8px; background: color-mix(in srgb, var(--fg) 7%, var(--bg)); color: var(--fg);
    font: 400 var(--chat-fs)/1.45 var(--font-app); }
  .composer .input :global(.editor:empty::before) { color: color-mix(in srgb, var(--fg) 55%, transparent); }
  .composer .row { display: flex; align-items: center; gap: 8px; }
  .composer .row .k { margin-right: auto; }
  /* the desktop's views take every pixel the chat doesn't */
  .split { position: absolute; z-index: 2; top: var(--under-bar); bottom: 26px; left: calc(var(--chat-at) + 2 * var(--app-gutter, 34px)); width: 14px; transform: translateX(-50%); cursor: col-resize; touch-action: none; }
  .split::after { content: ""; position: absolute; top: 0; bottom: 0; left: 6px; width: 2px; border-radius: 1px; background: var(--fg); opacity: 0; transition: opacity .15s; }
  .split:hover::after, .split:active::after { opacity: .35; }
  .side { position: absolute; top: max(var(--under-bar), var(--notice-foot, 0px)); bottom: 26px; right: var(--app-gutter, 34px); left: calc(var(--chat-at) + 3 * var(--app-gutter, 34px)); z-index: 1;
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
  /* a source: Quick's summary first, then how it came in, then the source itself */
  .vsum { margin: 0 0 18px; padding-bottom: 16px; border-bottom: 1px solid var(--rule); font: 400 calc(var(--chat-fs) * 1.07)/1.55 var(--font-app); color: var(--fg); }
  .vhead { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 16px; font: 400 12px/1.5 var(--font-mono); color: var(--v2-muted); }
  .vhead dt { color: var(--v2-faint); } .vhead dd { margin: 0; }
  /* the source itself, as a reader view: pictures fit the column, figures and quotes set apart */
  .vsrc :global(img) { display: block; max-width: 100%; height: auto; margin: 1.2em 0; border-radius: 6px; }
  /* a picture held for a click: where it's from, and the button */
  .vsrc :global(.held) { display: flex; align-items: baseline; gap: 12px; margin: 1.2em 0; padding: 10px 12px; border-radius: 6px;
    background: color-mix(in srgb, var(--fg) 5%, var(--bg)); font: 400 12px/1.5 var(--font-mono); color: var(--v2-faint); }
  .vsrc :global(.held span) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vsrc :global(.held button) { flex: none; border: 0; padding: 0; background: none; color: var(--v2-muted); font: 500 12px/1.5 var(--font-app); cursor: pointer; }
  .vsrc :global(.held button:hover) { color: var(--fg); }
  .vsrc :global(figure) { margin: 1.4em 0; } .vsrc :global(figcaption) { margin-top: -0.6em; font-size: 0.85em; color: var(--v2-muted); }
  .vsrc :global(blockquote) { margin: 1.1em 0; padding-left: 1em; border-left: 2px solid var(--rule); color: color-mix(in srgb, var(--fg) 80%, var(--bg)); }
  .vsrc :global(pre) { overflow-x: auto; padding: 12px 14px; border-radius: 8px; background: color-mix(in srgb, var(--fg) 5%, var(--bg)); font: 400 13px/1.5 var(--font-mono); }
  .vsrc :global(table) { border-collapse: collapse; font-size: 0.92em; } .vsrc :global(td), .vsrc :global(th) { padding: 4px 10px; border-bottom: 1px solid var(--rule); text-align: left; }
  .vsrc :global(hr) { border: 0; border-top: 1px solid var(--rule); margin: 1.6em 0; }
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
  .ask { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 14px 16px; border-radius: 16px;
    background: color-mix(in srgb, var(--fg) 9%, var(--bg)); font: 400 13px/1.55 var(--font-app); color: var(--v2-muted); }
  .ask p { margin: 0; }
  .ask .ask-head { font-weight: 550; color: var(--fg); }
  .ask code { display: block; align-self: stretch; max-height: 4.8em; overflow: auto; padding: 8px 10px; border-radius: 8px;
    background: color-mix(in srgb, var(--bg) 60%, transparent); font: 400 12px/1.5 var(--font-mono); color: var(--fg); overflow-wrap: anywhere; white-space: pre-wrap; }
  .allow { height: 30px; padding: 0 14px; border: 0; border-radius: 999px; background: var(--fg); color: var(--bg); font: 500 13px/1 var(--font-app); cursor: pointer; }
  .allow:hover { background: color-mix(in srgb, var(--fg) 86%, var(--bg)); }
  .ask-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .ask-actions .find { margin-left: 0; background: transparent; }
  .ask-actions .find:hover { background: color-mix(in srgb, var(--bg) 60%, transparent); }
  .ask-actions button:disabled { opacity: .45; cursor: default; }
  .review { display: flex; flex-direction: column; gap: 6px; font: 400 12px/1.6 var(--font-mono); color: var(--v2-muted); }
  .review p, .review ul { margin: 0; padding: 0; list-style: none; }
  .review li { display: flex; gap: 10px; padding: 0; cursor: default; }
  .review li code { flex: none; color: var(--fg); }
  .review b { font-weight: 500; color: var(--fg); }
  .review pre { margin: 0; max-height: 40vh; overflow: auto; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--fg) 5%, var(--bg)); font: 400 11.5px/1.5 var(--font-mono); color: var(--fg); white-space: pre; }
  .review span { display: inline-flex; gap: 16px; }
  .review .find { height: 24px; font-size: 12px; }
  .vbody :global(> :first-child) { margin-top: 0; } .vbody :global(p) { margin: 0 0 0.85em; }
  .vbody :global(ul), .vbody :global(ol) { margin: 0 0 0.85em; padding-left: 1.5em; } .vbody :global(li + li) { margin-top: 0.3em; }
  .vbody :global(h1), .vbody :global(h2), .vbody :global(h3), .vbody :global(h4) { margin: 1.2em 0 0.45em; font: 600 calc(var(--chat-fs) * 1.08)/1.35 var(--font-app); }
  .vbody :global(h1) { font-size: calc(var(--chat-fs) * 1.3); }
  .vbody :global(a) { color: inherit; text-decoration-color: color-mix(in srgb, var(--fg) 35%, transparent); text-underline-offset: 3px; }
  .vbody :global(a[href^="#/vault/"]) { color: var(--v2-muted); font-size: 0.92em; }
  .vbody :global(code) { font: 400 0.86em/1.4 var(--font-mono); } .vbody :global(pre) { white-space: pre-wrap; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  .vbody :global(blockquote) { margin: 0 0 0.85em; padding-left: 1em; border-left: 2px solid var(--rule); color: var(--v2-muted); }
  .vbody :global(table) { display: block; overflow-x: auto; border-collapse: collapse; font-size: 0.92em; } .vbody :global(th), .vbody :global(td) { border: 1px solid var(--rule); padding: 0.35em 0.6em; }
  .gear { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 999px; background: none; cursor: pointer; color: var(--v2-muted); }
  .gear:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }

  .hud { position: absolute; top: calc(var(--under-bar) + 10px); left: var(--app-gutter, 34px); width: min(460px, calc(100% - 32px)); display: flex; flex-direction: column; gap: 9px;
    pointer-events: none; text-shadow: 0 0 8px var(--bg), 0 0 18px var(--bg); }
  .eyebrow { font: 600 10px/1 var(--font-app); letter-spacing: 0.24em; text-transform: uppercase; color: var(--v2-muted); }
  h1 { margin: 0; font: 500 clamp(28px, 2.5vw, 36px)/1.05 var(--font-app); letter-spacing: -0.03em; }
  /* an assertion opened from the feed: a sentence for a title, not a name */
  .hud.claim { width: min(620px, calc(100% - 32px)); }
  .hud.claim h1 { font-size: clamp(20px, 1.7vw, 25px); line-height: 1.28; letter-spacing: -0.015em; }
  .hud p { margin: 0; max-width: 44ch; font: 400 14.5px/1.5 var(--font-app); color: color-mix(in srgb, var(--fg) 80%, var(--bg)); }
  .same { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; padding-left: 12px; border-left: 2px solid var(--rule); }
  .same-head { font: 600 10px/1 var(--font-app); letter-spacing: 0.24em; text-transform: uppercase; color: var(--v2-muted); }
  .hud .same-why { font-size: 13.5px; color: var(--v2-muted); }
  .cand { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
  .cand-name { font: 500 14.5px/1.3 var(--font-app); }
  .cand-name .arrow { color: var(--v2-muted); }
  .acts { display: flex; gap: 8px; pointer-events: auto; }
  .acts button { display: inline-flex; align-items: center; padding: 5px 10px; border: 1px solid var(--rule); border-radius: 7px;
    background: var(--bg); color: var(--fg); font: 500 12.5px/1 var(--font-app); cursor: pointer; text-shadow: none; }
  .acts button:hover { background: color-mix(in srgb, var(--fg) 6%, var(--bg)); }
  .same .busy { font: 400 12.5px/1.6 var(--font-app); color: var(--v2-muted); }

  .search { position: absolute; top: var(--under-bar); left: calc(var(--app-gutter, 34px) - 8px); width: min(480px, calc(100% - 32px)); z-index: 2;
    border-radius: 11px; background: var(--bg); box-shadow: 0 0 0 1px var(--rule); overflow: hidden; animation: v2fade .14s ease-out; }
  @keyframes v2fade { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .search { animation: none; } }
  .field { display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 18px; }
  .field input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--fg); font: 400 19px/1 var(--font-app); }
  /* the theme's own ink, softened — never the browser's grey */
  .field input::placeholder { color: color-mix(in srgb, var(--fg) 55%, transparent); opacity: 1; }
  .search .field + * { border-top: 1px solid var(--rule); }
  ul { list-style: none; margin: 0; padding: 4px 6px 8px; max-height: min(62vh, 560px); overflow-y: auto; }
  li { display: grid; grid-template-columns: 22px minmax(0, 1fr); grid-template-rows: auto auto; column-gap: 10px; padding: 9px 12px; border-radius: 8px; cursor: pointer; }
  li[aria-selected="true"] { background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  .dot { grid-row: span 2; align-self: center; justify-self: center; width: calc(var(--r) * 2); height: calc(var(--r) * 2); border-radius: 50%; background: var(--fg); }
  .ttl { font: 500 15px/1.3 var(--font-app); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  mark { background: none; color: color-mix(in srgb, var(--activity) 80%, var(--fg)); font-weight: 600; }
  .dot.src { background: none; box-shadow: inset 0 0 0 1.5px var(--fg); }
  .search .none { margin: 0; padding: 14px 22px 16px; font: 400 13.5px/1.4 var(--font-app); color: var(--v2-muted); }
  .meta { font: 400 12.5px/1.35 var(--font-app); color: var(--v2-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .feed { position: absolute; left: var(--app-gutter, 34px); bottom: 26px; width: min(880px, calc(100% - 68px)); display: flex; flex-direction: column; gap: 1px;
    font: 400 12.5px/1.35 var(--font-app); text-shadow: 0 0 6px var(--bg), 0 0 14px var(--bg); }
  .row { display: grid; grid-template-columns: 92px 120px minmax(0, 1fr); gap: 12px; align-items: baseline; padding: 2px 0; white-space: nowrap; cursor: pointer; transition: opacity .12s ease; }
  .row .w { font: 500 9.5px/1 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--v2-faint); font-variant-numeric: tabular-nums; }
  .row .a { font: 500 11px/1 var(--font-mono); overflow: hidden; text-overflow: ellipsis; }
  .row .a.client { color: var(--v2-muted); }
  .row .x { overflow: hidden; text-overflow: ellipsis; color: color-mix(in srgb, var(--fg) 82%, var(--bg)); }
  .row:nth-last-child(2) { opacity: .7; } .row:nth-last-child(3) { opacity: .5; } .row:nth-last-child(4) { opacity: .36; }
  .row:nth-last-child(5) { opacity: .25; } .row:nth-last-child(6) { opacity: .16; }
  .feed:hover .row { opacity: .45; } .feed .row:hover { opacity: 1; } .row:hover .x { color: var(--fg); }
  .feed .row.open, .feed:hover .row.open { opacity: 1; } .row.open .x { color: var(--fg); }
  /* the sorted feed: weight by section, not age */
  .sorted .row { opacity: 1; grid-template-columns: 92px minmax(0, 1fr); } .sorted .row.s-agent { opacity: .78; } .sorted .row.s-know { opacity: .55; }
  .sorted .due { margin-left: 10px; font: 500 9.5px/1 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--activity); }
  /* about eight rows tall; older ones scroll in above, fading at the top edge */
  .feed.sorted { display: block; max-height: 156px; overflow-y: auto; scrollbar-width: none; overscroll-behavior: contain;
    mask-image: linear-gradient(to bottom, transparent, #000 40px); padding-top: 40px; }
  .feed.sorted::-webkit-scrollbar { display: none; }
  /* the row in hand scrolls clear of the fade (the padding above lets the oldest) */
  .sorted .row.at { scroll-margin-top: 40px; }
  .sorted .row.at, .sorted .row.open { opacity: 1; } .sorted .row.at .x, .sorted .row.open .x { color: var(--fg); }
  .sorted .row.at .w { color: var(--activity); }
  .sorted.walking:not(:hover) .row:not(.at):not(.open) { opacity: .4; }
  .hints { position: absolute; right: var(--app-gutter, 34px); bottom: 26px; margin: 0; padding: 0; border: 0; background: none; cursor: pointer;
    display: flex; align-items: baseline; gap: 6px; font: 600 10px/1 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--v2-faint); }
  .hints:hover, .hints:focus-visible { color: var(--fg); }
  .hints kbd { font: inherit; }
  .notice { position: absolute; right: var(--app-gutter, 34px); bottom: 50px; max-width: 46ch; margin: 0; padding: 9px 12px; border-radius: 8px;
    background: color-mix(in srgb, var(--fg) 8%, var(--bg)); font: 400 13px/1.4 var(--font-app); color: var(--fg); }
  .empty { position: absolute; top: calc(var(--notice-band, 0px) + (100% - var(--notice-band, 0px)) * .38); left: calc((100% - var(--notice-lane, 0px)) / 2); transform: translate(-50%, -50%); width: min(460px, calc(100% - 32px)); display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
  .empty p { margin: 0; font: 400 14.5px/1.5 var(--font-app); color: var(--v2-muted); }
  .empty .find { margin-left: 0; color: var(--fg); background: color-mix(in srgb, var(--fg) 7%, var(--bg)); }
  .error { position: absolute; top: calc(var(--under-bar) + 18px); left: var(--app-gutter, 34px); font: 400 13px/1.5 var(--font-app); color: var(--v2-muted); }
  @media (max-width: 700px) {
    .row { grid-template-columns: 72px minmax(0, 1fr); } .row .w { display: none; }

  }
</style>
