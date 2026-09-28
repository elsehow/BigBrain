<script lang="ts">
  import { tick, untrack, onMount } from "svelte";
  import NotificationCenter from "../components/NotificationCenter.svelte";
  import LinkGraph from "../components/LinkGraph.svelte";
  import NodeIndicator from "../components/NodeIndicator.svelte";
  import type { PilotNotification } from "../lib/notificationTypes";
  import NoteTab from "../components/NoteTab.svelte";
  import { app } from "../lib/store.svelte";
  import type { PilotVisualPhase } from "../lib/pilotAppearance";
  import { BRIEFINGS, setVaultState } from "./fakeApi";
  import { attentionGraph, attentionNotifications, attentionSources } from "./attentionScenes";
  const { scene = "overview" }: { scene?: string } = $props();
  const initial = untrack(() => scene); // Workbench remounts on each scene change.
  let sources = $state(attentionSources.map(s => ({ ...s, unread: !["no-unread", "empty"].includes(initial) && s.unread })));
  let notices = $state<PilotNotification[]>(["quiet", "empty"].includes(initial) ? [] : attentionNotifications().map(n => ({ ...n, seen: initial === "seen" || n.seen })));
  if (initial === "long") notices = Array.from({ length: 12 }, (_, i) => ({ ...attentionNotifications()[i % 3]!, id: `long-${i}`, pilotTitle: "Research roadmap · a much longer conversation about evaluation and forecasting", text: i % 2 ? "The analysis is ready. I’ve linked the supporting material and the remaining questions in our conversation." : "There are two plausible ways to interpret the agent’s results, and the right next step depends on whether you want to prioritize the original study population or the expanded sample from the follow-up. Which should I use?", seen: i > 3 }));
  let open = $state(initial !== "quiet" && initial !== "failure");
  app.graphView = { selected: [], excluded: [] };
  const view = $derived(app.graphView);
  let researchWorking = $state(true);
  const pilotStates = $derived<Record<string, PilotVisualPhase>>({ conference: "idle", research: researchWorking ? "working" : "idle", reading: "answered" });
  let unreadView = $state(false);
  let active = $state<PilotNotification | null>(null);
  let triage = $state(false), triageSent = $state(false), settings = $state(false);
  let selectionAtStart = $state<string[]>([]);
  let draft = $state("");
  let composer = $state<HTMLTextAreaElement>();
  let syncFailure = $state(initial === "failure"), syncing = $state(false), error = $state(""), receipt = $state("");
  let reply = $state("");
  let search = $state("");
  const baseGraph = attentionGraph();
  if (initial === "quiet") {
    baseGraph.nodes.push({ id: "working-pilot", path: "working-pilot", title: "Research roadmap · working with agent", group: "pilot", degree: 1, x: 320, y: -220, pilotPhase: "working" });
    baseGraph.nodes.push({ id: "working-agent", path: "working-agent", title: "Checking results", group: "pilot", degree: 1, x: 410, y: -125, pilotPhase: "working", pilotActive: true });
    baseGraph.edges.push({ source: "working-pilot", target: "working-agent" });
  }
  const unread = $derived(sources.filter(s => s.unread));
  const selected = $derived(sources.filter(s => view.selected.includes(s.id) || view.selected.includes(`references/${s.id}.md`)));
  const graph = $derived({ ...baseGraph, nodes: baseGraph.nodes.map(n => {
    const source = sources.find(s => s.id === n.id);
    return source ? { ...n, readState: { unread: source.unread, provider: "email", writable: true, status: "synced" as const } } : n;
  }) });
  onMount(() => {
    setVaultState({ ...BRIEFINGS.ready!, graph: baseGraph, recent: [], streamBriefing: true,
      notes: Object.fromEntries(baseGraph.nodes.map(n => [n.path, { path: n.path, content: `# ${n.title}\n\nSample conversation material for ${n.title}.` }])),
      noteSummary: (keys) => keys.length > 1
        ? "Two decisions stand out: choose a conference date and confirm which dataset is the reference. Travel options support the date choice; the revised results support the dataset discussion. The reading-group messages offer papers and background notes. Unread status alone does not mean a reply is needed."
        : `This message concerns ${baseGraph.nodes.find(n => keys.includes(n.id) || keys.includes(n.path ?? ""))?.title ?? "the selected conversation"}. Review the source before deciding whether to reply.`,
    });
    return () => { app.activeNote = null; app.graphView = { selected: [], excluded: [] }; };
  });
  $effect(() => {
    app.activeNote = baseGraph.nodes.find(n => n.id === view.selected[0] || n.path === view.selected[0])?.path ?? null;
    app.view = "vault";
  });
  function selectUnread() {
    app.graphView = { selected: unread.map(s => s.id), excluded: [] };
    unreadView = true; triage = false; active = null; open = false; receipt = ""; error = ""; settings = false;
  }
  function toggleUnread(exists: boolean) {
    sources = sources.map((s, i) => ({ ...s, unread: exists && i !== 7 }));
    if (unreadView) app.graphView = { selected: sources.filter(s => s.unread).map(s => s.id), excluded: [] };
    receipt = ""; error = "";
  }
  async function startTriage() {
    if (!selected.length) return;
    selectionAtStart = selected.map(s => s.id); triage = true; triageSent = false; active = null; open = false; draft = "";
    await tick(); composer?.focus();
  }
  function showNotice(n: PilotNotification) {
    notices = notices.map(item => item.id === n.id ? { ...item, seen: true } : item);
    active = n; triage = false; reply = ""; settings = false;
    app.graphView = { selected: [n.pilotId], excluded: [] };
  }
  function dismiss(id: string) { notices = notices.map(n => n.id === id ? { ...n, dismissed: true } : n); }
  function answer(text: string) {
    if (!active || !text.trim()) return;
    notices = notices.map(n => n.id === active!.id ? { ...n, resolved: true } : n); reply = text; receipt = "Pilot has your answer.";
  }
  async function mark(ids: string[], isUnread: boolean) {
    syncing = true; error = ""; receipt = "";
    await new Promise(resolve => setTimeout(resolve, 300));
    if (syncFailure) error = "Gmail couldn’t confirm the change. Your unread selection is unchanged. Try again.";
    else {
      sources = sources.map(s => ids.includes(s.id) ? { ...s, unread: isUnread } : s);
      receipt = `${ids.length} ${ids.length === 1 ? "message" : "messages"} marked ${isUnread ? "unread" : "read"} in Gmail.`;
      if (unreadView) app.graphView = { selected: sources.filter(s => s.unread).map(s => s.id), excluded: [] };
    }
    syncing = false;
  }
  function key(e: KeyboardEvent) {
    if (e.key === "Enter" && e.shiftKey && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); void startTriage(); }
    if (e.key === "Escape" && !open) { active = null; triage = false; settings = false; }
  }
</script>

<svelte:window onkeydown={key} />
<section class="attention-workbench" aria-label="Notification center workbench">
  <div class="graph-ground"><LinkGraph data={graph} bind:viewState={app.graphView} controls={false}
    inset={{ top: 120, bottom: 200 }} onselect={() => { unreadView = false; triage = false; active = null; }} /></div>
  <div class="chrome">
    <label class="search"><svg width="18" height="18" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="9.5" cy="9.5" r="6.5" /><path d="M14.5 14.5L19 19" /></svg><input aria-label="Search the workbench sources" placeholder="search everything…" bind:value={search} /><span class="shortcut">/</span></label>
    <div class="chrome-actions">
      <button class="chrome-button unread-button" disabled={!unread.length} class:pressed={unreadView} onclick={selectUnread} aria-label={`Select all ${unread.length} unread sources`} title={unread.length ? `Select all unread (${unread.length})` : "no unread sources"}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></svg>{#if unread.length}<span class="count">{unread.length}</span>{/if}</button>
      <NotificationCenter items={notices} {pilotStates} bind:open onopen={item => { const notice = notices.find(n => n.id === item.id); if (notice) showNotice(notice); }} ondismiss={dismiss} onseen={() => { notices = notices.map(n => ({ ...n, seen: true })); }} />
      <button class="chrome-button gear" aria-label="Settings" title="Settings" onclick={() => { settings = !settings; open = false; }}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg></button>
    </div>
  </div>
  {#if settings}<div class="settings-preview"><strong>Settings</strong><p>Models · Integrations · Appearance</p><button onclick={() => settings = false}>Back to graph</button></div>{/if}
  {#if initial === "quiet" && !unreadView && !triage && !active}<div class="selection-summary"><NodeIndicator state="working" size={22} /><span>Research roadmap · working with its agent</span></div>{/if}
  {#if unreadView && !triage && !active}
    <div class="selection-summary"><span>{unread.length ? `${unread.length} unread sources selected` : "All read"}</span>{#if unread.length}<button onclick={startTriage}>Start a Pilot <kbd>⇧ ↵</kbd></button>{/if}<button class="quiet" onclick={() => { unreadView = false; app.graphView = { selected: [], excluded: [] }; }}>Clear</button></div>
  {/if}
  {#if error}<p class="receipt error" role="alert">{error}</p>{:else if receipt}<p class="receipt" role="status">{receipt}</p>{/if}
  {#if triage}
    <section class="conversation" aria-label="Unread triage Pilot">
      <header><NodeIndicator state="active" size={26} /><div><strong>Triage unread</strong><small>{selectionAtStart.length} sources in context</small></div><button class="close" onclick={() => triage = false} aria-label="Close triage">×</button></header>
      {#if triageSent}<div class="conversation-body"><p>These messages cover conference plans, the research results, and your reading group. The date choice and dataset question need decisions; the others are background material.</p><p>Which would you like to start with?</p><button class="action" disabled={syncing} onclick={() => mark(selectionAtStart, false)}>{syncing ? "Syncing with Gmail…" : "Mark these messages read"}</button>{#if error}<p role="alert">{error}</p>{/if}</div>{/if}
      <form onsubmit={(e) => { e.preventDefault(); if (draft.trim()) { triageSent = true; draft = ""; } }}><textarea bind:this={composer} aria-label="Message triage Pilot" bind:value={draft} placeholder="Help me triage these…" onkeydown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (draft.trim()) { triageSent = true; draft = ""; } } }}></textarea><button type="submit" aria-label="Send triage message" disabled={!draft.trim()}>↑</button></form>
    </section>
  {:else if active}
    <section class="conversation" aria-label="Pilot notification conversation">
      <header><NodeIndicator state={pilotStates[active.pilotId] ?? "idle"} size={26} /><div><strong>{active.pilotTitle}</strong><small>{reply ? "Answered" : active.kind === "question" ? "Waiting for your answer" : "Update"}</small></div><button class="close" onclick={() => active = null} aria-label="Close Pilot conversation">×</button></header>
      <div class="conversation-body"><p class="message-target" data-message-id={active.messageId}>{active.text}</p>{#if reply}<p class="reply">{reply}</p><p>Thanks — I’ll continue with that.</p>{:else if active.kind === "question" && active.id === "conference-choice"}<div class="choices"><button class="action" onclick={() => answer("Thursday, please.")}>Thursday</button><button class="action" onclick={() => answer("Friday, please.")}>Friday</button></div>{/if}</div>
      {#if active.kind === "question" && !reply}<form onsubmit={(e) => { e.preventDefault(); answer(draft); draft = ""; }}><textarea aria-label="Reply to Pilot" bind:value={draft} placeholder="Your answer…"></textarea><button type="submit" aria-label="Send answer" disabled={!draft.trim()}>↑</button></form>{/if}
    </section>
  {:else if view.selected.length}
    <section class="text-tab" aria-label="Selected sources text tab"><NoteTab {graph} /></section>
  {/if}
  <div class="scene-controls" aria-label="Workbench controls"><label><input type="checkbox" checked={unread.length > 0} onchange={(e) => toggleUnread(e.currentTarget.checked)} /> Unread messages exist</label><label><input type="checkbox" bind:checked={researchWorking} /> Research Pilot working</label><label><input type="checkbox" bind:checked={syncFailure} /> Simulate sync failure</label><button onclick={() => { sources = sources.map((s, i) => i === 0 ? { ...s, unread: !s.unread } : s); if (unreadView) app.graphView = { selected: sources.filter(s => s.unread).map(s => s.id), excluded: [] }; receipt = "Read state updated from Gmail."; }}>Change one in Gmail</button><span>Simulated data</span></div>
  <output class="sr-only" aria-label="Selected graph sources">{JSON.stringify(view.selected)}</output>
</section>

<style>
  .attention-workbench { position: relative; isolation: isolate; width: 100%; height: 100%; min-height: 540px; overflow: hidden; background: var(--bg); color: var(--text-strong); font: var(--type-body); container-type: inline-size; }
  .graph-ground { position: absolute; inset: 0 0 65px; z-index: 0; }
  .chrome { display: flex; align-items: center; gap: var(--sp-6); padding: 18px 28px 22px; position: relative; z-index: 4; background: color-mix(in oklab, var(--bg) 68%, transparent); backdrop-filter: blur(18px); }
  .search { flex: 1; min-width: 0; display: flex; align-items: center; gap: 14px; height: 52px; padding: 0 12px; background: var(--well); border-radius: var(--r-chip); } .search svg { flex: none; color: var(--icon); } .search input { width: 100%; min-width: 0; background: none; border: 0; outline: none; color: var(--text-strong); font: var(--type-chip); } .shortcut { font: 11px var(--font-mono); color: var(--text-muted); }
  .chrome-actions { display: flex; gap: var(--sp-4); align-items: center; flex: none; }
  .chrome-button { position: relative; width: var(--size-icon-btn); height: var(--size-icon-btn); border-radius: var(--r-full); background: var(--surface); color: var(--icon); border: 0; display: grid; place-items: center; cursor: pointer; flex: none; padding: 0; }
  .chrome-button:hover, .chrome-button.pressed { box-shadow: inset 0 0 0 1px var(--dash); }
  .count { position: absolute; right: -2px; top: -3px; height: 16px; min-width: 16px; border-radius: 10px; border: 2px solid var(--bg); background: var(--text-strong); color: var(--bg); font: 600 10px/12px var(--font-mono); box-sizing: border-box; }
  .selection-summary { position: absolute; top: 104px; left: 28px; right: 28px; display: flex; align-items: center; gap: 16px; z-index: 2; font: var(--type-meta); flex-wrap: wrap; } .selection-summary > span { font-weight: 600; }
  .selection-summary button, .action, .settings-preview button { border: 1px solid var(--rule); background: var(--bg); color: var(--text-strong); border-radius: 8px; padding: 8px 12px; font: var(--type-meta); cursor: pointer; } .selection-summary .quiet { border: 0; background: none; color: var(--text-muted); } kbd { margin-left: 12px; color: var(--text-muted); }
  .text-tab { position: absolute; z-index: 2; left: 28px; right: 28px; bottom: 76px; height: min(32%, 300px); display: flex; flex-direction: column; overflow: hidden; container-type: inline-size; border: 1px solid var(--rule); border-radius: 14px; background: var(--bg); box-shadow: 0 8px 24px color-mix(in srgb, var(--text-strong) 7%, transparent); }
  .conversation { position: absolute; z-index: 3; bottom: 76px; left: 50%; transform: translateX(-50%); width: min(640px, calc(100% - 56px)); max-height: calc(100% - 200px); overflow-y: auto; border: 1px solid var(--rule); border-radius: 14px; background: var(--bg); box-shadow: 0 8px 24px color-mix(in srgb, var(--text-strong) 7%, transparent); }
  .conversation header { display: flex; align-items: center; gap: 10px; padding: 18px 20px; } .conversation header > div { display: grid; gap: 2px; flex: 1; min-width: 0; } .conversation strong { font: 650 15px/1.4 var(--font-app); } .conversation small { color: var(--text-muted); font: var(--type-meta); } .close { border: 0; background: none; color: var(--text-muted); font-size: 22px; cursor: pointer; }
  .conversation-body { padding: 0 22px 20px; font: 15px/1.6 var(--font-app); } .conversation-body p { margin: 0 0 14px; } .choices { display: flex; gap: 8px; } .reply { text-align: right; color: var(--text-muted); }
  form { display: flex; align-items: flex-end; padding: 12px; border-top: 1px solid var(--rule); gap: 8px; } textarea { min-height: 46px; max-height: 140px; resize: vertical; flex: 1; min-width: 0; border: none; outline: none; background: var(--well); border-radius: 8px; padding: 12px; color: var(--text-strong); font: var(--type-body); } form button { width: 32px; height: 32px; border: 0; border-radius: 50%; background: var(--text-strong); color: var(--bg); font-size: 20px; cursor: pointer; } button:disabled { opacity: .45; cursor: default; }
  .receipt { position: absolute; z-index: 3; top: 145px; left: 28px; right: 28px; margin: 0; font: var(--type-meta); background: var(--bg); padding: 10px 12px; border-radius: 8px; width: fit-content; max-width: calc(100% - 56px); } .error { color: var(--activity); }
  .scene-controls { position: absolute; z-index: 2; bottom: 0; left: 0; right: 0; padding: 14px 20px; border-top: 1px solid var(--rule); display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; background: var(--bg); color: var(--text-muted); font: 11px/1.4 var(--font-app); } .scene-controls label { display: flex; gap: 6px; align-items: center; } .scene-controls button { font: inherit; color: inherit; border: 1px solid var(--rule); border-radius: 6px; background: none; padding: 5px 7px; cursor: pointer; } .scene-controls > span { margin-left: auto; font: 10px var(--font-mono); }
  .settings-preview { position: absolute; top: 90px; right: 28px; z-index: 5; background: var(--bg); border: 1px solid var(--rule); border-radius: 14px; padding: 24px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  @container (max-width: 580px) { .chrome { padding: 14px 16px 18px; gap: 10px; } .chrome-actions { gap: 8px; } .shortcut { display: none; } .search { gap: 8px; height: 48px; } .search input { font-size: 13px; } .text-tab { left: 16px; right: 16px; bottom: 130px; } .conversation { bottom: 115px; width: calc(100% - 32px); } .scene-controls { gap: 6px 12px; padding: 10px 16px; } .scene-controls > span { display: none; } .selection-summary { left: 16px; right: 16px; gap: 8px; } }
</style>
