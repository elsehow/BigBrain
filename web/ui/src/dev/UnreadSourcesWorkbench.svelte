<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import NoteTab from '../components/NoteTab.svelte';
  import { app } from '../lib/store.svelte';
  import { sourceAttention, refreshSourceAttention } from '../lib/sourceAttention.svelte';
  import { BRIEFINGS, setVaultState } from './fakeApi';
  import LinkGraph from '../components/LinkGraph.svelte';
  import type { GraphData } from '../lib/types';
  let { scene = 'crowded' }: { scene?: string } = $props();
  const initial = untrack(() => scene);
  const fixture: GraphData = { nodes: [], edges: [], hash: 'unread-crowded' };
  let seed = 31;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let cluster = 0; cluster < 9; cluster++) {
    const angle = cluster * Math.PI * 2 / 9, cx = Math.cos(angle) * 190, cy = Math.sin(angle) * 155;
    const hub = `topic-${cluster}`;
    fixture.nodes.push({ id: hub, title: ['Research', 'Projects', 'Meetings', 'Correspondence', 'Reading', 'Evaluations', 'Planning', 'Prototypes', 'Methods'][cluster]!, group: cluster % 3 ? 'entity' : 'memory', degree: 35, x: cx, y: cy });
    for (let i = 0; i < 33; i++) {
      const id = `source-${cluster}-${i}`, a = random() * Math.PI * 2, r = 25 + Math.sqrt(random()) * 130;
      fixture.nodes.push({ id, title: id, group: 'reference', degree: i % 5 === 0 ? 3 : 1, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      fixture.edges.push({ source: hub, target: id });
      if (i % 5 === 0) fixture.edges.push({ source: id, target: `topic-${(cluster + 1) % 9}` });
    }
    fixture.edges.push({ source: hub, target: `topic-${(cluster + 1) % 9}` });
  }
  const titles = ['Evaluation results', 'Project notes', 'Research meeting', 'Forecasting methods', 'Prototype review', 'Dataset correspondence'];
  fixture.nodes = fixture.nodes.map((n, i) => ({ ...n, path: n.group === 'reference' ? `log/insertions/2026-09/ins_${i.toString(16).padStart(24, '0')}.json` : `projection/entities/${n.id}.md`, group: n.group === 'reference' ? 'source' : n.group, title: n.group === 'reference' ? `${titles[i % titles.length]} ${i + 1}` : n.title }));
  let enabled = $state(true), hoverTitle = $state<string | null>(null), ready = $state(false);
  const seedUnread = new Set(fixture.nodes.filter(n => n.group === 'source').filter((_, i) => initial === 'many' ? i % 2 === 0 : initial === 'quiet' ? false : i % 5 === 0).map(n => n.id));
  const selected = $derived(app.graphView.selected[0] ?? null);
  const data: GraphData = $derived({ ...fixture, nodes: fixture.nodes.map(n => ({ ...n,
    readState: sourceAttention.rows.find(r => r.path === n.path)?.readState })) });
  const current = $derived(data.nodes.find(n => n.id === selected));
  const unread = $derived(data.nodes.filter(n => n.readState?.unread));
  function select(id: string | null) {
    app.graphView = { selected: id ? [id] : [], excluded: [] };
    app.activeNote = fixture.nodes.find(n => n.id === id)?.path ?? null;
  }
  async function reset() {
    setVaultState({ ...BRIEFINGS.ready!, graph: fixture, recent: [],
      sourceReadStates: fixture.nodes.filter(n => n.group === 'source').map(n => ({ path: n.path!, title: n.title, readState: { unread: seedUnread.has(n.id), writable: true, status: 'synced', provider: 'email' } })),
      notes: Object.fromEntries(fixture.nodes.map(n => [n.path!, { path: n.path!, content: `# ${n.title}\n\nFrom: Maya Chen\n\nI’ve attached the updated review notes. The comparison includes the original dataset and revised evaluation, with assumptions called out in the methods section.\n\nShould we run another check before sharing the results? I suggest reviewing the remaining examples together.`, ...(n.group === 'source' ? { sourceAssertions: [] } : {}) }])),
      noteSummary: keys => `${fixture.nodes.find(n => keys.includes(n.id))?.title ?? 'This source'} contains updated evaluation notes and asks whether another check is needed before sharing the results.`,
    });
    select(null); sourceAttention.error = ''; sourceAttention.receipt = ''; sourceAttention.selection = '';
    await refreshSourceAttention();
  }
  onMount(() => {
    let disposed = false;
    void reset().then(() => { if (!disposed) { ready = true; if (initial === 'text-tab') select('source-0-0'); } });
    return () => { disposed = true; select(null); sourceAttention.rows = []; };
  });
  $effect(() => { app.activeNote = current?.path ?? null; });

</script>
<div class="unread-workbench">
  <header><div><strong>Unread sources</strong><p>{data.nodes.length} nodes · <span data-unread-count>{unread.length} unread</span></p></div>
    <div class="controls"><label><input type="checkbox" bind:checked={enabled}/> Show indicators</label><button onclick={() => void reset()}>Reset</button></div>
  </header>
  <div class="canvas">
    <LinkGraph data={{ ...data, nodes: data.nodes.map(n => enabled ? n : { ...n, readState: undefined }) }} bind:viewState={app.graphView} onselect={select} bind:hoverTitle highlight={selected} controls/>
  </div>
  {#if ready && current}
    <section class="source-tab" aria-label="Source text tab">
      {#key current.id}<NoteTab graph={data} />{/key}
    </section>
  {/if}
  <footer><span>{current?.group === 'source' ? 'Opening a source leaves it unread until you choose Mark read.' : hoverTitle ?? 'Select a source to open its text tab.'}</span><button onclick={() => select(unread[0]?.id ?? null)} disabled={!unread.length}>Find an unread source</button></footer>
</div>
<style>
  .unread-workbench { position: relative; height: 100%; min-height: 540px; background: var(--bg); color: var(--ink); display: flex; flex-direction: column; }
  header { padding: 25px 30px; display: flex; justify-content: space-between; gap: 20px; align-items: center; }
  strong { font-size: 16px; font-weight: 600; } p { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
  .controls { display: flex; align-items: center; gap: 20px; font-size: 12px; color: var(--muted); }
  label { display: flex; gap: 6px; align-items: center; } input { accent-color: var(--activity); }
  button { background: var(--surface); color: var(--ink); border: 1px solid var(--rule); padding: 8px 12px; border-radius: 6px; cursor: pointer; font: inherit; } button:disabled { opacity: .4; }
  .canvas { flex: 1; min-height: 350px; position: relative; } 
  .source-tab { flex: 0 1 340px; min-height: 220px; margin: 0 24px; border: 1px solid var(--rule); border-radius: 10px; background: var(--bg); box-shadow: 0 6px 25px #00000006; overflow: hidden; display: flex; flex-direction: column; }
  footer { padding: 16px 30px; display: flex; justify-content: space-between; gap: 20px; align-items: center; color: var(--muted); font-size: 12px; }
  .unread-workbench:has(.source-tab) .canvas { min-height: 170px; }
  @media(max-width:600px) { header,footer { padding: 18px; } header,.controls { flex-wrap: wrap; } .source-tab { margin: 0 12px; flex-basis: 350px; } }
</style>
