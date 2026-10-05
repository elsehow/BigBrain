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
  async function notifyAgent() { window.dispatchEvent(new Event("workbench-agent-notification")); }
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
  import Base from '../components/Base.svelte';
  import { onboardingPreviewKey } from './onboardingFixture';
  const onboarding = new URLSearchParams(location.search).has('onboarding');
  function restartOnboarding() { localStorage.removeItem(onboardingPreviewKey); location.hash = ''; location.reload(); }
  const calmSidebar = new URLSearchParams(location.search).get('sidebarTone') !== 'original';
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
<!-- the production base and Field (its first run and vault gates included) -->
<Base />
{#if new URLSearchParams(location.search).has('gmail')}<aside class="gmail-preview">Sample setup · Use sample@example.com and abcd efgh ijkl mnop. No credentials are saved.</aside>{/if}
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
.gmail-preview{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:1000;background:var(--bg);color:var(--text-muted);border:1px solid var(--rule);padding:8px 14px;border-radius:6px;font:var(--type-meta);max-width:90vw}
.sidebar-study-switch { position:fixed; right:16px; z-index:40; display:flex; gap:14px; align-items:center; font:var(--type-meta); color:var(--text-muted); }
.sidebar-study-switch a { font:inherit; color:inherit; }
.sidebar-study-switch { top:16px; bottom:auto; max-width:calc(100vw - 32px); flex-wrap:wrap; justify-content:flex-end; }
@media(min-width:800px) { .sidebar-study-switch { max-width:calc(100vw - 580px); } }
.sidebar-study-switch.onboarding { top:auto; bottom:36px; right:140px; max-width:calc(100% - 156px); flex-wrap:wrap; background:var(--bg); border:1px solid var(--rule); padding:8px; }
.sidebar-study-switch button { background:var(--bg); color:inherit; border:1px solid var(--rule); padding:4px 8px; font:inherit; cursor:pointer; }
</style>
