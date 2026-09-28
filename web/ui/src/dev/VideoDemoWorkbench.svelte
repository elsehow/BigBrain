<script lang="ts">
  import LinkGraph from '../components/LinkGraph.svelte';
  import type { GraphData } from '../lib/types';

  const themes = ['default', 'dusk', 'web', 'phosphor', 'somethings-gotta-give', 'yamabukiiro', 'moegiiro', 'adzukiiro', 'asagiiro'];
  const scenes = [
    { name: 'After a meeting', title: 'Launch research', request: 'Pull out the action items from our last meeting and get to work on them.', answer: 'Two things from your meeting with Alex:', items: ['Compare the three onboarding approaches.', 'Draft a recommendation for Friday’s review.'], result: 'A comparison and a first draft, ready for your review.', sources: [
      {title: 'Alex / Sam · project sync', kind: 'Meeting', excerpt: 'Alex: Can you compare the three approaches and bring a recommendation to Friday’s review?'},
      {title: 'Onboarding research', kind: 'Project', excerpt: 'Goal: get to a first useful result. Options: guided setup, an example vault, or a personal walkthrough.'},
      {title: 'Interview notes', kind: 'Document', excerpt: 'Participants wanted to try a real task before spending time configuring their workspace.'}
    ]},
    { name: 'Morning inbox', title: 'What needs me?', request: 'Across my inboxes and Slack, what actually needs my attention?', answer: 'Two decisions need you. The rest can wait.', items: ['Approve the revised launch date.', 'Choose between the two interview plans.'], result: '18 unread messages → 2 decisions.', sources: [
      {title: 'A new launch date', kind: 'Email', excerpt: 'Alex: Can you confirm Thursday works before we update the launch schedule?'},
      {title: 'Research planning', kind: 'Slack', excerpt: 'Sam: We have two interview plans ready. Which should we use this week?'},
      {title: 'Weekly updates', kind: 'Email', excerpt: 'The remaining updates are informational. No response requested.'}
    ]},
    { name: 'Connect a reading', title: 'A useful connection', request: 'Could this paper help us with the onboarding problem?', answer: 'Yes. It matches a pattern in your interviews:', items: ['Show a useful result before asking for setup.', 'Start with a real task, then connect the sources.'], result: 'A new reading, connected to work already in progress.', sources: [
      {title: 'Learning through examples', kind: 'Sample paper', excerpt: 'A worked example gives learners a concrete starting point before introducing configuration.'},
      {title: 'Interview notes', kind: 'Document', excerpt: 'Participants wanted to try a real task before spending time configuring their workspace.'},
      {title: 'Onboarding research', kind: 'Project', excerpt: 'Our open question: how quickly can someone experience a first useful result?'}
    ]}
  ];
  let sceneIndex = $state(0);
  let step = $state(2);
  let filming = $state(true);
  let clean = $state(false);
  let hints = $state(true);
  let theme = $state('default');
  let source = $state<number | null>(null);
  let scene = $derived(scenes[sceneIndex]);
  let graph: GraphData = $derived({hash: `video-${sceneIndex}`, nodes: [
    {id: 'project', title: scene.title, group: 'project', degree: 3, x: 0, y: 0},
    ...scene.sources.map((s, i) => ({id: String(i), title: s.title, group: s.kind, degree: 1, x: [-80,95,20][i], y: [-60,-40,80][i]}))
  ], edges: scene.sources.map((_,i) => ({source:'project', target:String(i)}))});
  $effect(() => {document.documentElement.dataset.theme = theme;});
  function changeScene(index: number) {sceneIndex = index; source = null; step = 0;}
  function key(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, button'))) return;
    const k = event.key.toLowerCase();
    if (!['f','d','r','t','escape','arrowright','arrowleft','1','2','3'].includes(k)) return;
    event.preventDefault();
    if (k === 'f') clean = !clean;
    if (k === 'd') filming = !filming;
    if (k === 'escape') {clean = false; source = null;}
    if (k === 'r') {step = 0; source = null;}
    if (k === 't') theme = themes[(themes.indexOf(theme)+1)%themes.length];
    if (k === 'arrowright') step = Math.min(2, step+1);
    if (k === 'arrowleft') step = Math.max(0, step-1);
    if (['1','2','3'].includes(k)) changeScene(Number(k)-1);
  }
</script>

<svelte:window onkeydown={key} />
<div class="studio" class:clean>
  {#if !clean}
    <header class="controls">
      <div><strong>Recording preview</strong><p>Dev only · fictional sample scenes</p></div>
      <div class="settings">
        <label>Scene <select value={sceneIndex} onchange={(e) => changeScene(Number(e.currentTarget.value))}>{#each scenes as s,i}<option value={i}>{s.name}</option>{/each}</select></label>
        <label>Palette <select bind:value={theme}>{#each themes as t}<option value={t}>{t}</option>{/each}</select></label>
        <button class:active={filming} onclick={() => filming = !filming}>Demo type {filming ? 'on' : 'off'} · D</button>
        <button onclick={() => clean = true}>Clean frame · F</button>
      </div>
    </header>
  {/if}
  <main class="frame" class:filming>
    <div class="topbar"><strong>BigBrain</strong><span>{scene.title}</span><small>Sample scene</small></div>
    <div class="composition">
      <section class="conversation" aria-label="Agent conversation">
        <div class="agent"><span class="triangle">△</span> Pilot <span> / {scene.name}</span></div>
        <div class="eyebrow">You</div>
        <h1>{scene.request}</h1>
        {#if step >= 1}
          <div class="response">
            <div class="eyebrow">Pilot</div>
            <p>{scene.answer}</p>
            <ol>{#each scene.items as item}<li>{item}</li>{/each}</ol>
            <button class="citation" onclick={() => source = source === 0 ? null : 0}>↗ {scene.sources[0].title}</button>
          </div>
        {/if}
        {#if step >= 2}<div class="result"><span>✓</span><p>{scene.result}</p></div>{/if}
      </section>
      <aside aria-label="Connected context">
        <div class="context-title">Connected context <span>3 sources</span></div>
        <div class="graph"><LinkGraph data={graph} controls={false} embed={true} onselect={(id) => source = id !== null && id !== 'project' ? Number(id) : null} /></div>
        <div class="sources">{#each scene.sources as s,i}<button class:selected={source === i} onclick={() => source = source === i ? null : i}><small>{s.kind}</small><span>{s.title}<span class="arrow">↗</span></span></button>{/each}</div>
        {#if source !== null}<div class="excerpt"><div class="eyebrow">Source excerpt</div><p>{scene.sources[source].excerpt}</p><button onclick={() => source = null}>Close excerpt</button></div>{/if}
      </aside>
    </div>
    <footer><span>Your context. Connected.</span>{#if hints}<span>← → advance <span class="separator">/</span> T palette <span class="separator">/</span> Esc controls</span>{/if}</footer>
  </main>
  {#if !clean}
    <div class="director"><div>{#each ['Request','Context','Result'] as label,i}<button class:active={step === i} onclick={() => {step = i; source = null;}}>{i+1} · {label}</button>{/each}</div><label><input type="checkbox" bind:checked={hints} /> Show shortcut hints</label><span>← → advance · R reset · 1–3 scenes</span></div>
    <p class="notice">Layout prototype: responses are staged, not recorded agent runs. Click a source to inspect its excerpt.</p>
  {/if}
</div>

<style>
  .studio {min-height:100vh;padding:24px 32px;background:var(--surface);color:var(--fg);font-family:var(--font-sans, 'Hanken Grotesk', sans-serif)}
  .controls,.director,.notice {max-width:1600px;margin:0 auto}
  .controls {display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:20px}
  .controls strong {font-size:20px}.controls p {margin:5px 0 0;font-size:13px;opacity:.65}
  .settings {display:flex;gap:12px;align-items:end;flex-wrap:wrap}label {font-size:13px} .settings label {display:grid;gap:5px}
  button,select {font:inherit;color:inherit;background:transparent;border:1px solid var(--rule);border-radius:5px;padding:9px 12px;cursor:pointer}
  button:hover,button.active {background:var(--fg);color:var(--bg)}
  .frame {--reading:16px;--question:25px;--source:15px;container-type:inline-size;max-width:1600px;width:100%;aspect-ratio:16/9;margin:auto;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--rule);border-radius:9px;overflow:hidden}
  .frame.filming {--reading:clamp(20px,2cqw,32px);--question:clamp(27px,2.8cqw,45px);--source:clamp(17px,1.6cqw,25px)}
  .topbar {display:flex;align-items:center;gap:28px;padding:1.5% 4%;border-bottom:1px solid var(--rule)}
  .topbar strong {font-size:24px;letter-spacing:-1px}.topbar>span {opacity:.65;font-size:16px}.topbar small {margin-left:auto;font-size:12px;opacity:.55}
  .composition {flex:1;min-height:0;display:grid;grid-template-columns:1.75fr 1fr;gap:5%;padding:2.2% 4% 1%;overflow:auto}
  .agent {display:flex;align-items:center;gap:10px;font-size:18px;margin-bottom:3cqw}.agent>span:last-child {opacity:.55}.triangle {color:var(--activity);font-size:30px;line-height:1}
  .eyebrow {font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.55;margin-bottom:10px}
  h1 {font-size:var(--question);line-height:1.18;font-weight:500;letter-spacing:-.025em;margin:0 0 2.5cqw;max-width:24em}
  .response {font-size:var(--reading);line-height:1.4}.response p {margin:0 0 .8em}.response ol {padding-left:1.2em;margin:0 0 .7em}.response li {padding-left:.15em;margin-bottom:.3em}
  .citation {font-size:14px;border:0;padding:4px 0;color:var(--activity)}
  .result {display:flex;align-items:baseline;gap:15px;border-top:1px solid var(--rule);margin-top:1.5cqw;padding-top:1.4cqw;font-size:var(--reading);line-height:1.3}.result>span {color:var(--activity)}.result p {margin:0}
  aside {border-left:1px solid var(--rule);padding-left:8%;min-width:0}.context-title {font-size:16px;display:flex;justify-content:space-between;gap:10px}.context-title>span {font-size:13px;opacity:.5}
  .graph {height:13cqw;min-height:120px;max-height:205px;position:relative;margin:10px 0}
  .sources {display:grid}.sources button {text-align:left;border:0;border-top:1px solid var(--rule);border-radius:0;padding:16px 0;display:grid;gap:7px}.sources button.selected {color:var(--activity)}.sources button:hover {background:var(--surface);color:var(--fg)}
  .sources small {font-size:12px;opacity:.55}.sources button>span {font-size:var(--source);display:flex;justify-content:space-between;gap:10px;line-height:1.25}.arrow {opacity:.5}
  .excerpt {padding:16px;background:var(--surface);border-left:2px solid var(--activity);font-size:var(--source);line-height:1.35}.excerpt p {margin:0 0 12px}.excerpt button {font-size:12px;padding:5px 8px}
  footer {display:flex;justify-content:space-between;padding:1.4% 4%;font-size:12px;opacity:.5}.separator {padding:0 10px}
  .director {display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:18px;font-size:13px}.director>div {display:flex;gap:7px}.director>span,.notice {opacity:.6}.notice {font-size:12px;padding-top:15px}
  .clean {padding:0;background:var(--bg);display:grid;place-items:center;min-height:100vh}.clean .frame {width:min(100vw,177.7778vh);max-width:none;max-height:100vh;border:0;border-radius:0}
  @media(max-width:900px) {.studio{padding:16px}.controls,.director{flex-wrap:wrap}.frame{aspect-ratio:auto;min-height:760px}.composition{gap:3%;padding-top:24px}.agent{margin-bottom:24px;font-size:14px}.clean{padding:0}.clean .frame{max-height:none}.topbar>span{font-size:13px}}
</style>
