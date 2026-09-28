<script lang="ts">
  import { tick } from "svelte";
  import { pilot, pilotClearContext, pilotDismiss, pilotPress, pilotRelease, pilotSetSpeaking } from "../lib/pilot.svelte";
  import { pilotTimeline } from "../lib/pilotTimeline";
  import { phaseLabel } from "../lib/pilot";
  import { work, selectWork } from "../lib/workSessions.svelte";

  const timeline = $derived(pilotTimeline(pilot.lines, work.sessions, pilot.contextClearedAt));
  const preparing = $derived(pilot.held && pilot.phase !== "listening");
  const listening = $derived(pilot.held && pilot.phase === "listening");
  let transcript = $state<HTMLDivElement>();
  let follow = $state(true);
  function onKeydownCapture(e: KeyboardEvent): void {
    if (e.code !== "KeyC" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
    e.preventDefault();
    e.stopPropagation();
    pilotClearContext();
  }
  $effect(() => {
    void timeline; void pilot.live; void pilot.tools;
    if (follow) void tick().then(() => { if (transcript) transcript.scrollTop = transcript.scrollHeight; });
  });
</script>

<svelte:window onkeydowncapture={onKeydownCapture} />

<section class="conversation" data-phase={pilot.phase}>
  <header>
    <span class="actions">
      {#if pilot.navigation}<button class="result" type="button" onclick={pilotDismiss}>View {pilot.navigation.kind === "search" ? "results" : "note"} · {pilot.navigation.label}</button>{/if}
    </span>
    <button class="speaking-toggle" type="button" aria-label="Toggle speaking" aria-pressed={pilot.speaking} onclick={() => pilotSetSpeaking(!pilot.speaking)}>🗣️ <span class="toggle-track"><span class="toggle-thumb"></span></span></button>
  </header>
  {#if preparing || listening}
    <div class="capture" class:listening role="status" aria-live="polite">
      {#if preparing}<span class="spinner" aria-hidden="true"></span>{:else}<span class="mic-dot" aria-hidden="true"></span>{/if}
      <strong>{listening ? "Listening — speak now" : "Getting ready…"}</strong>
      <span>{listening ? "Release Space to send" : "Keep holding Space. Wait for green before speaking."}</span>
    </div>
  {:else}
  <div class="transcript" bind:this={transcript} role="log" aria-label="Conversation with Pilot"
    onscroll={(e) => { const el = e.currentTarget; follow = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
    {#each timeline as entry}
      {#if entry.kind === "turn"}
        {@const line = entry.line}
        {#if line.text}<p class:user={line.speaker === "user"}><span class="speaker">{line.speaker === "user" ? "You" : "Pilot"}</span>{line.text}</p>{/if}
      {:else}
        <p class="worker-event" data-event-key={entry.key}><span class="speaker">{entry.status} · <button class="back" data-talks-when-empty onclick={() => { pilotDismiss(); selectWork(entry.session); }}>{entry.title}</button></span>{entry.text}</p>
      {/if}
    {/each}
    {#if pilot.live}<p><span class="speaker">Pilot</span>{pilot.live}</p>{/if}
    {#if !timeline.length && !pilot.live}<p class="empty">Talk about what’s selected, ask a question, or start an agent.</p>{/if}
  </div>
  {/if}
  {#if pilot.error}<p class="error" role="alert">{pilot.error}</p>{/if}
  <footer>
    <button class="talk" class:held={pilot.held} data-talks-when-empty aria-pressed={pilot.held}
      onpointerdown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); void pilotPress(); }}
      onpointerup={pilotRelease} onpointercancel={pilotRelease} onlostpointercapture={pilotRelease}>
      <span class="space">SPACE</span>{listening ? "Release to send" : preparing ? "Keep holding" : "Hold to talk"}
    </button>
    {#if !["ready", "idle", "off", "error"].includes(pilot.phase)}<span class="status" aria-live="polite">{phaseLabel(pilot.phase, pilot.held)}</span>{/if}
    {#if work.context.session}
      <button class="back" data-talks-when-empty onclick={() => { pilotDismiss(); selectWork(work.context.session!); }}>View session</button>
    {/if}
  </footer>
</section>

<style>
  .capture { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-3); text-align: center; padding: var(--sp-4); border-radius: var(--r-sm); background: var(--well); color: var(--text-muted); }
  .capture strong { font: var(--type-heading); }
  .capture > span:last-child { font: var(--type-meta); }
  .capture.listening { background: color-mix(in srgb, var(--ok) 22%, var(--surface)); color: var(--ok); box-shadow: inset 0 0 0 2px var(--ok); }
  .spinner { width: 32px; height: 32px; border: 3px solid var(--rule); border-top-color: var(--text-strong); border-radius: 50%; animation: spin 0.8s linear infinite; }
  .mic-dot { width: 24px; height: 24px; background: var(--ok); border-radius: 50%; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .conversation { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); color: var(--text-strong); }
  header, footer { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-3); flex: none; }
  header { justify-content: space-between; }
  .actions { display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
  .back { padding: 0; background: none; border: none; color: var(--text-muted); cursor: pointer; font: var(--type-meta); text-align: left; }
  .result { padding: 0; border: 0; background: none; color: var(--accent-2); cursor: pointer; font: var(--type-meta); overflow-wrap: anywhere; }
  .transcript { overflow-y: auto; min-height: 0; flex: 1; }
  p { margin: 0 0 var(--sp-3); font: var(--type-body); white-space: pre-wrap; overflow-wrap: anywhere; }
  .speaker { display: block; font: var(--type-meta); color: var(--text-faint); margin-bottom: var(--sp-1); }
  .user, .empty { color: var(--text-muted); }
  .talk { display: inline-flex; align-items: center; gap: var(--sp-3); padding: 0; background: none; border: 0; color: var(--text-strong); font: var(--type-meta); cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; }
  .space { padding: 4px 12px; border: 1px solid var(--rule); border-bottom-width: 2px; border-radius: var(--r-sm); background: var(--well); font: var(--type-mono); }
  .held .space { border-color: var(--accent-3); }
  .status { font: var(--type-meta); color: var(--text-muted); }
  header .speaking-toggle { padding: 3px 7px; border: 1px solid var(--rule); border-radius: 999px; background: var(--well); color: var(--text-muted); font: var(--type-meta); cursor: pointer; }
  .toggle-track { display: inline-flex; width: 24px; height: 14px; padding: 2px; vertical-align: middle; border-radius: 999px; background: var(--rule); }
  .toggle-thumb { width: 10px; height: 10px; border-radius: 50%; background: var(--text-muted); transition: transform .15s ease; }
  .speaking-toggle[aria-pressed="true"] .toggle-track { background: var(--ok); }
  .speaking-toggle[aria-pressed="true"] .toggle-thumb { transform: translateX(10px); background: white; }
  .error { font: var(--type-meta); color: var(--accent-5); margin: 0; }
</style>
