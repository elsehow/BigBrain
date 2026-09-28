<script lang="ts">
  import LinkGraph from '../components/LinkGraph.svelte';
  import type { GraphData } from '../lib/types';
  let selected = $state<string | null>(null);
  let hoverTitle = $state<string | null>(null);
  const data: GraphData = { nodes: [], edges: [], hash: 'agent-endpoints-preview' };
  const topics = ['Research', 'Projects', 'Reading', 'Planning', 'Household', 'Field notes'];
  for (let c = 0; c < 6; c++) {
    const angle = c * Math.PI / 3, x = Math.cos(angle) * 230, y = Math.sin(angle) * 200;
    data.nodes.push({ id: `topic-${c}`, title: topics[c]!, group: 'memory', degree: 30, x, y });
    for (let n = 0; n < 28; n++) {
      const a = n * 2.4, r = 25 + Math.sqrt(n) * 17;
      data.nodes.push({ id: `note-${c}-${n}`, title: `${topics[c]} · note ${n + 1}`, group: 'source', degree: 1, x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
      data.edges.push({ source: `topic-${c}`, target: `note-${c}-${n}` });
    }
    const id = `agent-${c}`;
    data.nodes.push({ id, title: `${topics[c]} agent`, group: 'pilot', degree: 2, pilotPhase: c === 0 ? 'working' : 'active', x: x + 90, y: y - 100 });
    for (const n of [3, 19]) data.edges.push({ source: `note-${c}-${n}`, target: id, pilotContext: true });
  }
</script>
<div class="workbench">
  <header><div><h1>Agent connections</h1><p>Hover an agent to reveal its destinations. Click to keep them highlighted.</p></div>
    <div class="controls"><button onclick={() => selected = null}>Clear selection</button></div>
  </header>
  <main><LinkGraph {data} {selected} bind:hoverTitle onselect={id => selected = id} onblank={() => selected = null} controls /></main>
  <footer>{hoverTitle ?? 'Active agents keep their connections visible'}<span>Synthetic data · preview only</span></footer>
</div>
<style>
  .workbench { height:100dvh; display:flex; flex-direction:column; background:var(--bg); color:var(--text); }
  header { display:flex; justify-content:space-between; align-items:center; gap:24px; padding:22px 28px; border-bottom:1px solid var(--rule); }
  h1 { margin:0 0 6px; font:500 22px var(--font-app); } p, footer { margin:0; font:14px var(--font-app); color:var(--text-muted); }
  .controls { display:flex; gap:8px; flex-wrap:wrap; } button { padding:8px 12px; border:1px solid var(--rule); color:var(--text); background:transparent; cursor:pointer; font:14px var(--font-app); }
  main { flex:1; min-height:0; position:relative; } footer { padding:14px 28px; display:flex; justify-content:space-between; gap:20px; }
</style>
