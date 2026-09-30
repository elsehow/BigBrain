<script lang="ts">
  import { pilotScenarios } from "./applicationScenarios";
  const scenario = new URLSearchParams(location.search).get("scenario");
  const traces = pilotScenarios(Number(new URLSearchParams(location.search).get("seed") ?? 41));
  function chooseScenario(event: Event) {
    const url = new URL(location.href); url.searchParams.set("scenario", (event.target as HTMLSelectElement).value); url.searchParams.delete("step"); location.href = url.href;
  }
  function notifyCapture() {
    const dataTransfer = new DataTransfer();
    for (const name of ['agreement-fri.txt', 'signed-contractor-agreement.txt']) {
      dataTransfer.items.add(new File(['Sample agreement for the notification preview.'], name, { type: 'text/plain' }));
    }
    const event = new Event('drop');
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: dataTransfer.files, items: [] } });
    window.dispatchEvent(event);
  }
  import { onMount } from "svelte";
  import { refreshNotifications } from "../lib/notifications.svelte";
  import { refreshChats } from "../lib/pilotChat.svelte";
  async function notifyAgent() { window.dispatchEvent(new Event("workbench-agent-notification")); await refreshChats(); await refreshNotifications(); }
  import { update } from "../lib/update.svelte";
  onMount(() => {
    const params = new URLSearchParams(location.search);
    const timer = !params.has("vault") && params.has("notification") ? setTimeout(async () => {
      await notifyAgent();
      if (params.get('notification') === 'stack') { await notifyAgent(); await notifyAgent(); }
      if (params.has('captures')) void notifyCapture();
    }, 1200) : undefined;
    const scene = params.get("update");
    if (scene) { update.available = { version: "0.7.24", notes: "Preview update" }; update.phase = scene === "installing" ? "installing" : scene === "failed" ? "failed" : "idle"; update.error = scene === "failed" ? "Could not reach the download server." : null; }
    return () => clearTimeout(timer);
  });
  import AppShell from '../components/AppShell.svelte';
  import GraphProfileControls from './GraphProfileControls.svelte';
  import { onboardingPreviewKey } from './onboardingFixture';
  const onboarding = new URLSearchParams(location.search).has('onboarding');
  function restartOnboarding() { localStorage.removeItem(onboardingPreviewKey); location.hash = ''; location.reload(); }
  const calmSidebar = new URLSearchParams(location.search).get('sidebarTone') !== 'original';
  onMount(() => {
    if (new URLSearchParams(location.search).get('selectionSubgraph') !== '1') return;
    document.documentElement.dataset.sidebarTone = calmSidebar ? 'calm' : 'original';
    return () => { delete document.documentElement.dataset.sidebarTone; };
  });
  function compareSidebar() { const url = new URL(location.href); url.searchParams.set('sidebarTone', calmSidebar ? 'original' : 'calm'); location.href = url.href; }
  const staged = new URLSearchParams(location.search).get('choreography') !== 'plain';
  function compareChoreography() { const url = new URL(location.href); url.searchParams.set('choreography', staged ? 'plain' : 'staged'); location.href = url.href; }
  const continuous = new URLSearchParams(location.search).get('motion') !== 'independent';
  function compareMotion() { const url = new URL(location.href); url.searchParams.set('motion', continuous ? 'independent' : 'continuous'); location.href = url.href; }
  const composed = new URLSearchParams(location.search).get('composition') !== 'plain';
  function compareComposition() { const url = new URL(location.href); url.searchParams.set('composition', composed ? 'plain' : 'composed'); location.href = url.href; }
  const cloud = new URLSearchParams(location.search).get('selectionStyle') !== 'radial';
  function compareSelection() { const url = new URL(location.href); url.searchParams.set('selectionStyle', cloud ? 'radial' : 'cloud'); location.href = url.href; }
  const live = new URLSearchParams(location.search).get('vault') === 'live';
  const baseline = new URLSearchParams(location.search).get('layout') === 'original';
  const feedbackPreview = (onboarding || !live) && new URLSearchParams(location.search).has('feedback');
  let feedbackMode = $state(new URLSearchParams(location.search).get('feedback') === 'failure' ? 'failure' : 'success');
  function changeFeedbackMode() {
    const url = new URL(location.href); url.searchParams.set('feedback', feedbackMode);
    history.replaceState(null, '', url);
  }
</script>
<AppShell {baseline} debug />
{#if new URLSearchParams(location.search).has('gmail')}<aside class="gmail-preview">Sample setup · Use sample@example.com and abcd efgh ijkl mnop. No credentials are saved.</aside>{/if}
{#if !live && new URLSearchParams(location.search).has('profile')}<GraphProfileControls />{/if}
<nav class="sidebar-study-switch" class:onboarding aria-label="Workbench previews">
  {#if scenario}<label>Application scenario <select aria-label="Application scenario" value={scenario} onchange={chooseScenario}>{#each traces as trace}<option value={trace.id}>{trace.title}</option>{/each}</select></label><span>Read-only · seed {traces[0].seed}</span>{/if}
  {#if onboarding}<span>Onboarding preview · Analytics and connections simulated</span><button onclick={restartOnboarding}>Restart preview</button>
  {:else}
  {#if !live}<button onclick={notifyCapture}>Capture notifications</button><button onclick={notifyAgent}>Agent notification</button>{/if}
  {#if new URLSearchParams(location.search).get('selectionSubgraph') === '1'}<span>{cloud ? 'Cloud · Up to 120 items' : 'Radial · Up to 60 items'} · Hover labels · Shift-click to add · Escape to reset</span><button onclick={compareSelection}>Compare: {cloud ? 'radial' : 'cloud'}</button>{#if cloud}<button onclick={compareComposition}>{composed ? 'Compare: plain cloud' : 'Try: composed cloud'}</button><button onclick={compareMotion}>{continuous ? 'Compare: fresh layout' : 'Try: continuous layout'}</button><button onclick={compareChoreography}>{staged ? 'Compare: simultaneous reveal' : 'Try: staged reveal'}</button>{/if}<button onclick={compareSidebar}>{calmSidebar ? 'Compare: bold sidebar' : 'Try: quiet sidebar'}</button>{/if}
  <span>{live ? 'Local vault' : 'Sample vault'}</span>
  <a href={`?vault=${live ? 'sample' : 'live'}${baseline ? '&layout=original' : ''}`}>{live ? 'Sample' : 'Local vault'}</a>
  <a href={`?vault=${live ? 'live' : 'sample'}${baseline ? '' : '&layout=original'}`}>{baseline ? 'Sidebar study' : 'Original layout'}</a>
  {/if}
  {#if feedbackPreview}<label>Send is simulated <select aria-label="Simulated feedback outcome" bind:value={feedbackMode} onchange={changeFeedbackMode}><option value="success">Success</option><option value="failure">Failure</option></select></label>{/if}
</nav>

<style>
:global(html[data-sidebar-tone="calm"] .drawer:not(.sidebar-quick) .sheet) { position:relative; }
:global(html[data-sidebar-tone="calm"] .drawer:not(.sidebar-quick) .sheet:has(.block-scrollbar) .note-scroll) { margin-right:16px; }
:global(html[data-sidebar-tone="calm"] .drawer:not(.sidebar-quick) .briefing) { padding-inline:0; }
:global(html[data-sidebar-tone="calm"] .drawer:not(.sidebar-quick) .summary-column) { padding-inline:var(--sidebar-title-inset); }
:global(html[data-sidebar-tone="calm"] .drawer:not(.sidebar-quick) .source-links) { margin-inline:0; padding-inline:0; }
:global(html[data-sidebar-tone="calm"] .drawer:not(.sidebar-quick) .source-link) { padding-inline:var(--sidebar-title-inset); }

:global(html[data-sidebar-tone="calm"] .drawer:not(.sidebar-quick) .note-header) { padding-bottom:28px; border-bottom-color:color-mix(in srgb, var(--rule) 65%, transparent); }
:global(html[data-sidebar-tone="calm"] .drawer:not(.sidebar-quick) .briefing) { padding-top:34px; gap:38px; }
:global(html[data-sidebar-tone="calm"] .source-link) { position:relative; font-size:15px; line-height:1.5; min-height:44px; padding:11px 14px; border-radius:5px; gap:12px; }
:global(html[data-sidebar-tone="calm"] .source-link .link-title) { font-weight:500; letter-spacing:-.005em; }
:global(html[data-sidebar-tone="calm"] .source-link .link-description) { font-size:13px; line-height:1.55; color:var(--text-muted); }
:global(html[data-sidebar-tone="calm"] .source-link:is(.lk-on,:focus-visible)) { background:var(--text-strong); color:var(--bg); --mark:var(--bg); --glyph-bg:var(--text-strong); }
:global(html[data-sidebar-tone="calm"] .source-link:is(.lk-on,:focus-visible) .link-description) { color:inherit; }
:global(html[data-sidebar-tone="calm"] .source-link) { border-radius:0; }
:global(html[data-sidebar-tone="calm"] .drawer:not(.sidebar-quick) .note-title) { font:600 24px/1.3 var(--font-app); letter-spacing:-.015em; }
:global(html[data-sidebar-tone="calm"] .note-ts) { font:400 12px/1.5 var(--font-app); }
:global(html[data-sidebar-tone="calm"] .note-actions .pchip) { font:500 12px/18px var(--font-app); letter-spacing:0; padding:7px 10px; min-height:32px; box-sizing:border-box; gap:8px; }
:global(html[data-sidebar-tone="calm"] .note-actions :is(kbd,.kbd)) { font:400 11px/18px var(--font-mono); letter-spacing:0; color:var(--text-muted); }

.gmail-preview{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:1000;background:var(--bg);color:var(--text-muted);border:1px solid var(--rule);padding:8px 14px;border-radius:6px;font:var(--type-meta);max-width:90vw}
.sidebar-study-switch { top:16px; bottom:auto; max-width:calc(100vw - 32px); flex-wrap:wrap; justify-content:flex-end; }
@media(min-width:800px) { .sidebar-study-switch { max-width:calc(100vw - 580px); } }
.sidebar-study-switch.onboarding { top:auto; bottom:36px; right:140px; max-width:calc(100% - 156px); flex-wrap:wrap; background:var(--bg); border:1px solid var(--rule); padding:8px; }
.sidebar-study-switch button { background:var(--bg); color:inherit; border:1px solid var(--rule); padding:4px 8px; font:inherit; cursor:pointer; }
</style>
