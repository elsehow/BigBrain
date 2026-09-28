<script lang="ts">
  import type { WorkSummary } from '../../../../lib/workViews';
  import { agentVisualState } from '../lib/agentAppearance';
  import { selectWork } from '../lib/workSessions.svelte';
  import AgentIndicator from './AgentIndicator.svelte';
  let { agent, compact = false, unavailable = false }: { agent: WorkSummary; compact?: boolean; unavailable?: boolean } = $props();
  const status = $derived(unavailable ? 'Status unavailable — reconnecting…' : (agent.worker?.archivedAt || agent.external?.archivedAt) ? 'Archived'
    : (agent.worker?.request?.kind === 'context') ? 'Waiting for Pilot'
    : agent.status === 'starting' ? 'Starting' : agent.status === 'working' ? 'Working'
    : agent.status === 'idle' ? 'Turn finished' : agent.status === 'failed' ? 'Failed'
    : agent.status === 'interrupted' ? 'Interrupted' : 'Needs attention');
</script>
<button class="agent-handoff" class:compact onclick={() => selectWork(agent.id)} aria-label={`Open agent: ${agent.title} · ${status}`}>
  <AgentIndicator state={unavailable ? "stopped" : agentVisualState(agent)} size={20} />
  <span class="title">{agent.title}</span><span class="status">· {status}</span>
</button>
<style>
  button { display:inline-flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); max-width:100%; margin:0 0 var(--sp-5); padding:var(--sp-2) var(--sp-3); border:1px solid currentColor; border-radius:var(--r-sm, 6px); background:transparent; color:var(--activity); font:var(--type-meta); cursor:pointer; text-align:left; }
  .compact { margin:0; padding:6px 0; border:0; }
  .title { overflow-wrap:anywhere; } .status { opacity:.8; }
  button:hover { background:var(--well); } button:focus-visible { outline:2px solid var(--activity); outline-offset:3px; }
</style>
