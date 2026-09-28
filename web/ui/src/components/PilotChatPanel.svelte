<script lang="ts">
  import PilotEnvironmentRequest from "./PilotEnvironmentRequest.svelte";
  import { inspectActions } from "../lib/actionHistory.svelte";
  import ArchiveIcon from "./ArchiveIcon.svelte";
  import { renameChat, loadChatDetail } from "../lib/pilotChat.svelte";
  import AgentHandoff from './AgentHandoff.svelte';
  import { work } from '../lib/workSessions.svelte';
  import { pilotVisualPhase } from "../lib/pilotAppearance";
  import KeyboardModifier from "./KeyboardModifier.svelte";
  import { changeNotification, refreshNotifications } from "../lib/notifications.svelte";
  import { editable } from "../lib/dom";
  import type { PilotNotification } from "../../../../lib/pilotNotifications";
  import ChatImages from "./ChatImages.svelte";
  import { draftImages, setDraftImages, pasteImages, imageUploads } from "../lib/chatImages.svelte";
  import { keyboardHints } from "../lib/keyboardHints.svelte";
  import PilotBackendPicker from "./PilotBackendPicker.svelte";
  import TextTabResize from "./TextTabResize.svelte";
  import { pilot, pilotPress, pilotRelease, pilotStop } from "../lib/pilot.svelte";
  import { retryPilotInput, resumeChatQueue, stopChat } from "../lib/pilotChat.svelte";
  import { isMac } from "../lib/dom";
  const mac = isMac();
  import { SIDEBAR_LAYOUT, type SidebarLayout } from "../lib/sidebarLayout";
  const sidebar = getContext<SidebarLayout | undefined>(SIDEBAR_LAYOUT);
  import { tooltip } from "../lib/tooltip";
  import { getContext, tick, untrack } from "svelte";
  import { pilotContextLabel } from "../../../../lib/pilotChatTypes";
  import { activeChat, chat, chatSessions, openChat, editChatDraft, sendChat, archiveChat, leaveChat, removeChatContext, holdChatComposer } from "../lib/pilotChat.svelte";
  import { app, gotoNote } from "../lib/store.svelte";
  import { md, sanitizeHtml } from "../lib/markdown";
  import PilotChatIndicator from "./PilotChatIndicator.svelte";
  import PilotMentionComposer from "./PilotMentionComposer.svelte";
  import { parseMentions, serializeMentions } from "../../../../lib/pilotMentions";
  import { firstRecents, recentHits } from "../lib/floatingSearch.svelte";
  import { withPilotSearch } from "../lib/pilotSearch";
  import { connectedMentions, boostConnectedMentions } from "../lib/pilotMentionSuggestions";
  import { findNode } from "../../../../lib/graphIdentity";
  import { mentionItem } from "../lib/pilotMentionItems";
  import { api } from "../lib/api";
  import type { SearchHit } from "../lib/omnibox.svelte";
  const { expanded = false, resizing = false, resizable = true, onresize }: { expanded?: boolean; resizing?: boolean; resizable?: boolean; onresize: (expanded: boolean) => void } = $props();
  let recent = $state<SearchHit[]>(recentHits(api.cachedRecent(12) ?? { recent: [], nextOffset: null }).hits);
  let recentLoading = $state(untrack(() => !recent.length));
  let recentError = $state(false);
  const recents = $derived(withPilotSearch(recent, chatSessions(), "").filter(hit => hit.dir !== "pilot").map(mentionItem));
  async function search(query: string, signal: AbortSignal) {
    const page = await api.searchPage(query, 0, 50, signal, true);
    return boostConnectedMentions(withPilotSearch(page.hits, chatSessions(), query, { graph: chat.graph, mention: true }).map(mentionItem), suggestions.items);
  }
  $effect(() => {
    void app.rev;
    let disposed = false;
    void untrack(() => firstRecents()).then(page => { if (!disposed) recent = recentHits(page).hits; })
      .catch(() => { if (!disposed) recentError = true; }).finally(() => { if (!disposed) recentLoading = false; });
    return () => { disposed = true; };
  });
  const s = $derived(activeChat());
  const sessionId = $derived(s?.id);
  const connectedAgents = $derived(work.sessions.filter(agent => agent.worker && !agent.worker.archivedAt && agent.origin?.pilot === s?.id));
  const sessionError = $derived.by(() => {
    const error = chat.error || s?.error || s?.ingestionError || "";
    return error === "Pilot completed without an answer."
      ? "The model ended its turn without a reply. Send a message to continue." : error;
  });
  let memoryBodies = $state<Record<string, string>>({});
  let mentionSession = $state<string | null>(null);
  const mentionOpen = $derived(!!s && mentionSession === s.id);
  const suggestions = $derived(mentionOpen ? connectedMentions(chat.graph, s?.context ?? [], memoryBodies) : { label: "Connected", items: [] });
  $effect(() => {
    if (!mentionOpen) return;
    const graph = chat.graph;
    const memories = (s?.context ?? []).map(id => graph?.nodes[findNode(graph.nodes, id)])
      .filter(n => n?.group === "memory" && n.path);
    void app.rev;
    memoryBodies = {};
    let disposed = false;
    void Promise.all(memories.map(async n => {
      try { return [n!.id, (await api.note(n!.path!)).content] as const; }
      catch { return [n!.id, ""] as const; }
    })).then(entries => { if (!disposed) memoryBodies = Object.fromEntries(entries); });
    return () => { disposed = true; };
  });
  let stopArmed = $state(false);
  $effect(() => { void sessionId; stopArmed = false; });
  $effect(() => { if (sessionId) return holdChatComposer(sessionId); });
  let input = $state<PilotMentionComposer>();
  let transcript = $state<HTMLDivElement>();
  let readingColumn = $state<HTMLDivElement>();
  let moreBelow = $state(false);
  let showContext = $state(false), showBackend = $state(false);
  $effect(() => {
    if (!sidebar || !showBackend) return;
    const dismiss = () => { showBackend = false; };
    sidebar.dismissEditor = dismiss;
    return () => { if (sidebar.dismissEditor === dismiss) sidebar.dismissEditor = undefined; };
  });
  let follow = $state(true);
  function updateScrollState(): void {
    moreBelow = !!transcript && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight > 2;
  }
  $effect(() => {
    if (!transcript || !readingColumn) return;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(transcript);
    observer.observe(readingColumn);
    updateScrollState();
    return () => observer.disconnect();
  });
  const title = (id: string) => chat.graph?.nodes.find(n => n.id === id)?.title ?? s?.contextNodes?.find(n => n.id === id)?.title ?? chat.sessions.find(n => n.id === id)?.title ?? id;
  const images = $derived(s ? draftImages(s.id) : []);
  const context = $derived(s ? pilotContextLabel(s, title) : "");
  const activity = (tool: string) => ({ connecting: "Message queued", load_memory: "Reading memory", search_vault: "Searching", read_note: "Reading", inbox_list: "Checking inbox", inbox_read: "Reading thread", set_context: "Updating context", recent: "Reading recent items", read_file: "Reading file", write_scratch: "Writing scratch", list_files: "Reading folder", list_directories: "Finding projects", launch_agent: "Launching agent", read_agent: "Checking agent", reply_agent: "Answering agent" }[tool] ?? "Working");
  function render(text: string): string {
    const linked = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, path: string, label: string) => `[${(label ?? title(path)).replace(/[\[\]]/g, "") }](#/vault/${encodeURIComponent(path)})`);
    return sanitizeHtml(md(linked));
  }
  function citation(e: MouseEvent): void {
    const a = (e.target as Element).closest("a");
    const href = a?.getAttribute("href");
    if (!href?.startsWith("#/vault/")) return;
    e.preventDefault();
    if (sidebar) sidebar.documentReturn = s?.id;
    gotoNote(decodeURIComponent(href.slice(8)));
  }
  export function scrollToBottom(): void {
    follow = true;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
    updateScrollState();
  }
  export function beginCollapse(): (progress: number) => void {
    const from = transcript?.scrollTop ?? 0;
    return progress => {
      if (!transcript) return;
      const bottom = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
      transcript.scrollTop = from + (bottom - from) * progress;
      updateScrollState();
    };
  }
  export function close(): void {
    if (!s || chat.interrupting[s.id]) return;
    void archiveChat(s.id, stopArmed).then(stopped => { if (stopped) { input?.blur(); sidebar?.goHome?.(); } });
  }
  export function shiftEscape(): void { close(); }
  let renaming = $state(false), renameValue = $state(''), renameError = $state(''), renameBusy = $state(false);
  let titleInput = $state<HTMLInputElement>();
  async function beginRename() {
    if (!s) return;
    renameValue = s.title; renameError = ''; renaming = true;
    await tick(); titleInput?.focus(); titleInput?.select();
  }
  async function saveRename() {
    if (!s || renameBusy) return;
    if (!renameValue.trim()) { renameError = 'Enter a title.'; return; }
    renameBusy = true;
    try { await renameChat(s.id, renameValue.trim()); renaming = false; await tick(); input?.focus(); }
    catch (e) { renameError = (e as Error).message; }
    finally { renameBusy = false; }
  }
  export function handleKey(e: KeyboardEvent): boolean {
    if (renaming) {
      if (e.key === 'Escape') { renaming = false; renameError = ''; void tick().then(() => input?.focus()); return true; }
      if (e.key === 'Enter') { void saveRename(); return true; }
      return false;
    }
    if (e.key === 'r' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !editable(e.target)) { void beginRename(); return true; }
    if (stopArmed && e.key !== "Shift" && !(e.key === "Escape" && e.shiftKey)) stopArmed = false;
    if (e.key === "Escape" && !e.shiftKey && input?.dismissMenu()) return true;
    if (!e.defaultPrevented && !e.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
        && !showBackend && transcript && ['PageUp', 'PageDown'].includes(e.key)) {
      follow = false;
      transcript.scrollTop += (e.key === 'PageDown' ? 1 : -1) * transcript.clientHeight * .85;
      updateScrollState();
      return true;
    }
    if (resizable && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { onresize(e.key === "ArrowUp"); return true; }
    return false;
  }
  export function escape(): void {
    if (sidebar) { sidebar.goHome?.(); return; }
    stopArmed = false;
    if (input?.dismissMenu()) return;
    if (showContext) { showContext = false; return; }
    if (!s) return;
    app.graphView = { selected: [], excluded: [] }; void leaveChat();
    input?.blur();
  }
  $effect(() => { void sessionId; void chat.focus; void tick().then(() => { input?.focus(); }); });
  let lastJump = -1;
  const notices = $derived(s?.notifications ?? []);
  function hasNextTurn(notice: PilotNotification): boolean {
    const at = s?.messages?.findIndex(m => m.id === notice.messageId) ?? -1;
    return !!notice.resolved || !notice.workerRequest && at >= 0 && !!s?.messages?.slice(at + 1).some(m => m.role === 'user');
  }
  const unreadEligible = $derived(notices.filter(n => !hasNextTurn(n)));
  let viewedSession = '', viewedNotices = new Set<string>();
  $effect(() => {
    if (!s) return;
    if (viewedSession !== s.id) { viewedSession = s.id; viewedNotices = new Set(); }
    const arriving = notices.filter(n => !viewedNotices.has(n.id));
    arriving.forEach(n => viewedNotices.add(n.id));
    if (arriving.some(n => !n.seen)) void refreshNotifications().then(() => Promise.all(arriving.filter(n => !n.seen).map(n => changeNotification(n.id, 'seen')))).catch(e => chat.error = e.message);
  });
  async function markUnread(notice: PilotNotification) {
    try { await changeNotification(notice.id, 'unseen'); }
    catch(e) { chat.error = (e as Error).message; }
  }
  function noticeKey(e: KeyboardEvent) {
    if (!sidebar || !unreadEligible.length || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return;
    if (e.key.toLowerCase() !== 'u' || !e.shiftKey) return;
    e.preventDefault(); e.stopImmediatePropagation(); void markUnread(unreadEligible.at(-1)!);
  }
  function send(): void {
    chat.replyNotification = null;
    follow = true; chat.messageTarget = null; void sendChat();
  }
  $effect(() => {
    const jump = chat.messageJump;
    if (lastJump === jump) return;
    const target = chat.messageTarget;
    if (!target || !s?.messages?.some(m => m.id === target)) return;
    lastJump = jump; follow = false;
    void tick().then(() => { transcript?.querySelector(`[data-message-id="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "center" }); });
  });
  $effect(() => { void s?.live; void s?.phase; void s?.messages?.length; if (follow && !resizing) void tick().then(() => { if (transcript) transcript.scrollTop = transcript.scrollHeight; }); });
</script>
<svelte:window onkeydowncapture={noticeKey} />
{#if s}
<section class="pilot-panel" class:expanded class:resizing aria-label="Pilot conversation" data-phase={s.phase}>
  <header>
    <PilotChatIndicator phase={pilotVisualPhase(s)} /><strong class="chat-title">
      {#if renaming}<input class="chat-title-input" aria-label="Chat title" bind:this={titleInput} bind:value={renameValue} maxlength="100" disabled={renameBusy} />
      {:else}<button class="rename-chat" aria-label="Rename chat" aria-keyshortcuts="r" onclick={beginRename}>{s.title}<kbd class="keyboard-hint">r</kbd></button>{/if}
    </strong>
    <span class="status" class:visually-hidden={!["interrupted", "failed"].includes(s.phase)} role="status">{s.phase === "working" ? activity(s.activity) : s.phase === "interrupted" ? "Interrupted" : s.phase === "failed" ? "Needs attention" : s.phase === "answered" ? new Date(s.updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
    {#if context}<button class="context" onclick={() => showContext = !showContext} aria-expanded={showContext}>{context}</button>{/if}
    <div class="commands">
      <button class="model-command" aria-label={`Change model (${s.backend?.model ?? s.model})`} title={s.backend?.model ?? s.model} aria-expanded={showBackend} onclick={() => showBackend = !showBackend}>{s.backend?.model ?? s.model}</button>
      <button onclick={() => inspectActions(s.id, "Conversation actions")}>Action history</button>
      {#if pilot.configured}<button onpointerdown={(e) => { e.preventDefault(); void pilotPress(); }} onpointerup={pilotRelease} onpointercancel={pilotRelease}>Hold to talk</button>{/if}
      {#if ["speaking", "thinking"].includes(pilot.phase)}<button onclick={pilotStop}>Stop speech</button>{/if}
      {#if resizable}<TextTabResize {expanded} {onresize} />{/if}
      {#if !sidebar && (s.phase === "working" || chat.interrupting[s.id])}<button onclick={() => stopChat(s.id)} disabled={chat.interrupting[s.id]} aria-label="Interrupt Pilot" aria-keyshortcuts={mac ? "Meta+." : "Control+."} use:tooltip={mac ? "Interrupt Pilot (⌘.)" : "Interrupt Pilot (Ctrl+.)"}>{chat.interrupting[s.id] ? "Interrupting…" : "Interrupt"} {#if keyboardHints.show}<kbd class="keyboard-hint">{mac ? "⌘." : "Ctrl+."}</kbd>{/if}</button>{/if}
      {#if !sidebar}<button onclick={send} disabled={chat.interrupting[s.id] || imageUploads[s.id]?.busy || (!(chat.drafts[s.id] ?? s.draft).trim() && !images.length)}><span class="keyboard-hint">↵ </span>{s.phase === "working" ? "Queue" : "Send"}</button>{/if}
      {#if !sidebar}
      <button onclick={escape}>Esc {s.phase === "draft" && !(chat.drafts[s.id] ?? s.draft).trim() ? "Cancel" : "Back to graph"}</button>
      {/if}
      <button class="icon-command close-pilot" class:archive-control={!!sidebar} onclick={close} disabled={chat.interrupting[s.id]} aria-label="Archive Pilot" aria-keyshortcuts="Shift+Escape" use:tooltip={"Archive Pilot (Shift-Esc)"}><ArchiveIcon />{#if sidebar}<kbd class="keyboard-hint"><KeyboardModifier name="shift" />Esc</kbd>{/if}</button>
    </div>
  </header>
  {#if showContext}<div class="context-items">{#each s.context as id}<span>{title(id)}<button aria-label={`Remove ${title(id)} from context`} onclick={() => removeChatContext(id)}>×</button></span>{:else}<span>No attached items.</span>{/each}</div>{/if}
  {#if showBackend}<div class="backend-settings">{#key s.id}<PilotBackendPicker ondone={sidebar ? () => showBackend = false : undefined} id={s.id} value={s.backend} disabled={s.phase === "working"} />{/key}</div>{/if}
  <!-- The listener delegates clicks from native anchors in sanitized Markdown. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
  <div class="transcript" class:more-below={moreBelow} bind:this={transcript} role="log" aria-label="Pilot messages" aria-live="polite" aria-busy={s.detail.status === "loading"} onclick={citation}
    onscroll={() => { if (transcript && !resizing) follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40; updateScrollState(); }}>
    <div class="reading-column" bind:this={readingColumn}>
      {#if s.detail.status === "loading" && !s.messages?.length}<p role="status">Loading conversation…</p>{/if}
      {#if s.detail.status === "error"}<p class="error" role="alert">{s.detail.error} <button onclick={() => void loadChatDetail(s.id).catch(() => {})}>Retry</button></p>{/if}
      {#each s.messages ?? [] as message (message.id)}
        {@const notice = notices.find(n => n.messageId === message.id)}
        <div class:user={message.role === "user"} class:notice-message={!!notice} class:notice-approval={!!notice?.workerRequest && !notice.resolved} class:notice-unread={!!notice && !notice.seen} role={notice ? "group" : undefined} aria-label={notice ? "Agent notification" : undefined} class="message" data-message-id={message.id} class:notification-target={chat.messageTarget === message.id}>
          {#if message.role === "user"}
            <span class="user-label">You</span>
            <div class="user-text">{#each parseMentions(message.text) as part}{#if "text" in part}{part.text}{:else}<button class="sent-mention" onclick={() => { if (chat.sessions.some(s => s.id === part.mention.id)) openChat(part.mention.id); else gotoNote(part.mention.id); }}>{part.mention.title}</button>{/if}{/each}</div>
          {:else}{@html render(message.text)}{/if}
          <ChatImages images={message.images ?? []} />
          {#if notice?.workerRequest && !notice.resolved}<PilotEnvironmentRequest requestKey={notice.workerRequest} pilotId={s.id} unread={!notice.seen} />{/if}
          {#if notice && !hasNextTurn(notice)}
            <div class="notification-actions">
              <button onclick={() => void markUnread(notice)} disabled={!notice.seen} use:tooltip={'Mark unread (Shift-U)'}>{notice.seen ? 'Mark unread' : 'Unread'} <kbd class="keyboard-hint"><KeyboardModifier name="shift" />U</kbd></button>
            </div>
          {/if}
        </div>
      {/each}
      {#if s.live}<div class="message">{@html render(s.live)}</div>{/if}
    </div>
  </div>
  {#if s.pendingInputs?.length}<div class="queued-inputs" aria-label="Queued messages">
    {#each s.pendingInputs as pending (pending.id)}<div class="queued-input"><span>Queued</span><p>{#each parseMentions(pending.text) as part}{"text" in part ? part.text : part.mention.title}{/each}</p><ChatImages images={pending.images ?? []} /></div>{/each}
    {#if s.phase !== "working"}<button onclick={() => resumeChatQueue(s.id)}>Resume queued messages</button>{/if}
  </div>{/if}
  <div class="conversation-status">
    {#if s.phase === "working"}
      <div class="working-status" role="status">
        <PilotChatIndicator phase="working" />
        <span>{chat.interrupting[s.id] ? "Stopping…" : `${activity(s.activity)}…`}</span>
      </div>
    {/if}
    {#if connectedAgents.length}
      <div class="connected-activity" role="status" aria-label="Connected agent activity">
        {#each connectedAgents as agent (agent.id)}<AgentHandoff {agent} compact unavailable={!!work.error} />{/each}
      </div>
    {/if}
    {#if pilot.error}<p class="error" role="alert">{pilot.error}<button onclick={() => retryPilotInput(s.id).catch(e => pilot.error = e.message)}>Retry delivery</button></p>{/if}
    {#if sessionError}<p class="error" role="alert">{sessionError} <button onclick={() => inspectActions(s.id, "Conversation actions")}>Inspect actions</button></p>{/if}
  </div>
  <div class="image-draft"><ChatImages {images} remove={index => setDraftImages(s.id, images.filter((_, i) => i !== index))} />
    {#if imageUploads[s.id]?.busy}<p role="status">Attaching image…</p>{/if}
    {#if imageUploads[s.id]?.error}<p role="alert">{imageUploads[s.id].error}</p>{/if}
  </div>
  {#if renameError}<p class="error" role="alert">{renameError}</p>{/if}
  <div class="transcript-navigation"><span class="keyboard-hint"><kbd>PgUp/PgDn</kbd> scroll</span></div>
  {#key s.id}
    <PilotMentionComposer onimagepaste={e => pasteImages(s.id, e)} bind:this={input} autofocus={true} currentId={s.id} value={chat.drafts[s.id] ?? s.draft}
      onmenu={open => { mentionSession = open ? s.id : null; }}
      {recents} {recentLoading} {recentError} {search} connected={suggestions.items.slice(0, 8)} connectedLabel={suggestions.label}
      placeholder={s.messages?.length || s.detail.status === "loading" ? "Continue the conversation…" : s.seed.length === 1 ? `ask about ${title(s.seed[0])}` : "ask anything…"}
      onchange={parts => editChatDraft(s.id, serializeMentions(parts))} onsend={send} />
  {/key}
  {#if sidebar}<div class="composer-actions"><button onpointerdown={e => e.preventDefault()} onclick={send} disabled={chat.interrupting[s.id] || imageUploads[s.id]?.busy || (!(chat.drafts[s.id] ?? s.draft).trim() && !images.length)}><span class="keyboard-hint">↵ </span>{s.phase === "working" ? "Queue" : "Send"}</button></div>{/if}
</section>
{/if}
<style>
  .rename-chat { border:0; padding:0; background:none; color:inherit; font:inherit; text-align:left; cursor:text; max-width:100%; overflow:hidden; text-overflow:ellipsis; }
  .rename-chat kbd { margin-left:10px; color:var(--text-muted); font:var(--type-meta); }
  .chat-title-input { width:100%; box-sizing:border-box; background:var(--bg); color:var(--text-strong); border:0; border-bottom:1px solid currentColor; font:inherit; padding:0; outline:none; }

  .transcript-navigation { flex:none; box-sizing:border-box; width:100%; max-width:calc(58ch + 48px); align-self:center; margin-top:auto; padding:0 24px 8px; text-align:right; color:var(--text-muted); font:var(--type-meta); }
  .transcript-navigation kbd { font:inherit; }
  .message :global(table) { display:block; max-width:100%; overflow-x:auto; border-collapse:collapse; margin:1em 0; }
  .message :global(th), .message :global(td) { border:1px solid var(--rule); padding:.45em .65em; vertical-align:top; }
  .message :global(th) { text-align:left; font-weight:600; background:var(--well); }
  .queued-inputs { width: calc(100% - 48px); max-width: 58ch; max-height: 140px; overflow-y: auto; flex: 0 1 auto; align-self: center; color: var(--text-muted); font: 400 17px/1.6 var(--font-app); }
  .queued-input { padding: 8px 0; } .queued-input > span { font: 500 11px/1.6 var(--font-app); text-transform: uppercase; letter-spacing: 1px; } .queued-input p { margin: 4px 0; font: 400 20px/1.5 var(--font-app); white-space: pre-wrap; overflow-wrap: anywhere; }
  .image-draft { width: calc(100% - 48px); max-width: 58ch; align-self: center; font: var(--type-meta); }
  .notification-target { outline: 1px solid var(--rule); outline-offset: 6px; border-radius: 0; }
  .message.notice-message { padding:20px; border:1px solid var(--text-strong); border-radius:0; }
  .message.notice-unread { background:var(--text-strong); color:var(--bg); --pilot-color:var(--bg); }
  .message.notice-approval { background:var(--bg); color:var(--fg); border-color:var(--rule); --pilot-color:var(--activity); }
  .notification-actions { display:flex; flex-wrap:wrap; gap:16px; margin-top:18px; font:var(--type-meta); }
  .notification-actions button { color:inherit; background:none; border:0; padding:0; font:inherit; cursor:pointer; }
  .notification-actions button:disabled { opacity:.6; cursor:default; }
  .notification-actions kbd { font:inherit; opacity:.7; margin-left:4px; }
  .model-command { max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .backend-settings { padding: 12px 24px; overflow: auto; flex: none; max-height: 250px; }
  .conversation-status { flex: none; width: calc(100% - 48px); max-width: 58ch; align-self: center; font: 400 18px/1.5 var(--font-app); }
  .conversation-status .error { margin: 10px 0; }
  .connected-activity { display: flex; flex-direction: column; align-items: flex-start; max-height: 140px; overflow-y: auto; padding-block: 8px; }
  .working-status { display: flex; align-items: center; gap: 8px; padding: 0 0 24px; margin-top: 18px; color: var(--text-muted); font: var(--type-meta); }
  .pilot-panel { container: session-panel / inline-size; --pilot-color: var(--activity); display: flex; flex-direction: column; min-height: 0; height: 100%; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; flex: none; padding: 12px 20px; border-bottom: 1px solid var(--rule); font: 10px var(--font-mono); letter-spacing: 1.3px; text-transform: uppercase; }
  strong { color: var(--pilot-color); white-space: nowrap; max-width: 25%; overflow: hidden; text-overflow: ellipsis; }
  button { font: inherit; color: inherit; background: transparent; border: 0; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--pilot-color); outline-offset: 3px; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .status { color: var(--text-muted); white-space: nowrap; }
  .context { text-transform: uppercase; letter-spacing: inherit; text-align: left; color: var(--text-muted); white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
  .commands { display: flex; align-items: center; gap: 12px; margin-left: auto; flex: none; color: var(--text-muted); }
  .commands button { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; padding: 0 4px; border-radius: 4px;
    font: 10px/1 var(--font-mono); text-transform: uppercase; letter-spacing: 1px; white-space: nowrap; color: inherit; }
  .commands button:not(:disabled):hover { background: var(--well); }
  .commands .icon-command { width: 28px; height: 28px; padding: 0; flex: none; }
  .commands button:disabled { opacity: .4; cursor: default; }
  .pilot-panel :global(.mention-composer) { flex: 0 0 auto; margin-top: 0; align-self: center; width: 100%; max-width: calc(58ch + 48px); font: 400 17px/1.6 var(--font-app); }
  .transcript { flex: 0 1 auto; min-height: 0; max-height: min(24vh, 240px); overflow-y: auto; padding: 0 24px; font: 400 18px/1.5 var(--font-app); color: var(--text); }
  .transcript.more-below { mask-image: linear-gradient(to bottom, #000 calc(100% - 40px), transparent); }
  .expanded .transcript, .resizing .transcript { flex: 1; max-height: none; }
  .reading-column { width: 100%; max-width: 58ch; margin-inline: auto; }
  .message { margin: 28px 0; overflow-wrap: anywhere; }
  .message:last-child { margin-bottom: 0; padding-bottom: 24px; }
  .message :global(p) { margin: 0 0 20px; font: inherit; }
  .message :global(ul), .message :global(ol) { margin: 16px 0; padding-left: 1.8em; }
  .message :global(li + li) { margin-top: 12px; }
  .message :global(li > ul), .message :global(li > ol) { margin: 8px 0; }
  .message :global(> :last-child) { margin-bottom: 0; }
  .message :global(a) { color: var(--pilot-color); text-decoration-thickness: 1px; text-underline-offset: 4px; }
  .user { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 16px; align-items: baseline; }
  .user-label { color: var(--activity); font: 500 11px/1.6 var(--font-app); text-transform: uppercase; letter-spacing: 1px; }
  .user-text { color: var(--text-muted); font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
  .pilot-panel :global(.editor) { padding-left: 24px; padding-right: 24px; font: 400 18px/1.5 var(--font-app); }
  @media (max-width: 600px) { .transcript { padding: 0 16px; } .pilot-panel :global(.editor) { padding-inline: 16px; } .user { grid-template-columns: 30px minmax(0, 1fr); gap: 10px; } }

  .error { color: var(--accent-5); margin: 10px 23px; font: var(--type-meta); }
  .context-items { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 23px 0; font: var(--type-meta); }
  .context-items span { background: var(--well); border-radius: 5px; padding: 4px 8px; }
  .context-items button { margin-left: 8px; }
  @media (max-width: 850px) { header { flex-wrap: wrap; gap: 8px; padding: 10px 14px; } strong { max-width: 65%; } .context { flex: 1; } .commands { width: 100%; justify-content: flex-end; gap: 12px; } }
  @container session-panel (max-width: 1000px) { .context { display: none; } }

  .message :global(h2) { font: 500 22px/1.25 var(--font-app); letter-spacing: -.02em; margin: 0 0 16px; }
  .message :global(h3) { font: 500 22px/1.3 var(--font-app); }
  .message :global(strong) { font-weight: 600; }
  .message :global(a[href^="#/vault/"]) { font-family: var(--font-app); font-size: .9em; line-height: inherit; letter-spacing: normal; }
  .expanded header { gap: 10px; }
  .commands { flex-wrap: wrap; gap: 8px; min-width: 0; max-width: 100%; }
  .pilot-panel:not(.expanded) .message { margin-top: 18px; margin-bottom: 18px; }
  @media (min-width: 1050px) { .expanded .transcript { padding-inline: 32px; } .pilot-panel.expanded :global(.editor) { padding-inline: 32px; } }
</style>
