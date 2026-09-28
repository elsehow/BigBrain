<script lang="ts">
  import { tick } from 'svelte';
  import VaultPicker from '../components/VaultPicker.svelte';
  import logo from '../assets/logo.svg';
  const steps = ['Vault', 'Providers', 'Clients', 'Integrations'];
  const providers = [{ id: 'claude', name: 'Claude' }, { id: 'chatgpt', name: 'ChatGPT' }];
  const clients = [{ id: 'claude', name: 'Claude Code' }, { id: 'chatgpt', name: 'Codex' }];
  const library = [
    { id: 'browser', name: 'Browser extension', description: 'Save pages and highlights to your vault.', symbol: '↗' },
    { id: 'granola', name: 'Granola', description: 'Bring your meeting transcripts into your vault.', symbol: '≋' },
  ];
  let step = $state(0), vault = $state(''), connected = $state<string[]>([]), granted = $state<string[]>([]);
  let added = $state<string[]>([]), paired = $state<string[]>([]), configuring = $state(''), busy = $state('');
  let remember = $state(true), live = $state(true), complete = $state(false);
  const defaultRule = "Record raw transcripts, correcting garbled ASR with vault context. Ignore Granola's automated summary.";
  let rule = $state(defaultRule);
  let heading = $state<HTMLHeadingElement>();
  let generation = 0;
  let panel = $state<HTMLDivElement>();
  let moving = $state(false);
  async function go(next: number) {
    if (moving || next === step && !complete) return;
    moving = true;
    const direction = next > (complete ? steps.length : step) ? 1 : -1;
    const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const leaving = motion ? panel?.animate([
      { transform: 'translateX(0)', opacity: 1 },
      { transform: `translateX(${-direction * 24}px)`, opacity: 0 },
    ], { duration: 120, easing: 'ease-in', fill: 'forwards' }) : undefined;
    if (leaving) await leaving.finished;
    complete = next === steps.length;
    if (!complete) step = next;
    configuring = '';
    await tick();
    leaving?.cancel();
    const entering = motion ? panel?.animate([
      { transform: `translateX(${direction * 24}px)`, opacity: 0 },
      { transform: 'translateX(0)', opacity: 1 },
    ], { duration: 180, easing: 'ease-out' }) : undefined;
    if (entering) await entering.finished;
    moving = false;
    await tick();
    heading?.focus();
  }
  function reset() { generation++; step=0; vault=''; connected=[]; granted=[]; added=[]; paired=[]; configuring=''; busy=''; remember=true; live=true; complete=false; rule=defaultRule; }
  async function connect(id: string, provider = false) {
    const current = generation;
    busy = id;
    await new Promise(resolve => setTimeout(resolve, 450));
    if (current !== generation) return;
    if (provider) {
      connected = [...connected, id]; busy = '';
    } else { paired = [...paired, id]; busy = ''; }
  }
  function selectClient(id: string, checked: boolean) { granted = checked ? [...granted, id] : granted.filter(c => c !== id); }
  function add(id: string) { added = [...added, id]; configuring = id; }
  const nextReady = $derived(step === 0 ? !!vault : step === 1 ? connected.length > 0 : !busy);
</script>

<div class="study-bar"><span>Setup study · Simulated connections</span><button disabled={moving} onclick={reset}>Restart</button></div>
<main>
  <div class="brand"><img src={logo} alt="" width="36" height="36" /><span>BigBrain</span></div>
  <nav aria-label="Setup steps">
    {#each steps as name, index}
      <button class:current={step===index && !complete} class:done={step>index || complete} aria-current={step===index && !complete ? 'step' : undefined} disabled={!!busy || moving || (index > 0 && (!vault || index > 1 && !connected.length))} onclick={()=>go(index)}><span class="number">{step>index || complete ? '✓' : index+1}</span><span>{name}</span></button>
    {/each}
  </nav>
  <div class="step-frame"><div class="step-content" bind:this={panel} inert={moving}>
  {#if complete}
    <section class="finished">
      <div class="eyebrow">Ready</div><h1 bind:this={heading} tabindex="-1">Your vault is ready.</h1><p class="intro">{vault}</p>
      <dl><div><dt>Providers</dt><dd>{providers.filter(p=>connected.includes(p.id)).map(p=>p.name).join(', ')}</dd></div><div><dt>Clients</dt><dd>{clients.filter(p=>granted.includes(p.id)).map(p=>p.name).join(', ') || 'None yet'}</dd></div><div><dt>Integrations</dt><dd>{library.filter(p=>added.includes(p.id)).map(p=>p.name).join(', ') || 'None yet'}</dd></div></dl>
      <a class="button primary" href="/sidebar-workbench.html">Open sample vault →</a>
    </section>
  {:else}
    <header><div class="eyebrow">Step {step+1} of 4</div>
      <h1 bind:this={heading} tabindex="-1">{['Where should your vault live?', 'Connect providers', 'Connect clients', 'Connect integrations'][step]}</h1>
      <p class="intro">{['Pick an empty folder, or one that already holds a BigBrain vault.', 'BigBrain will use your subscriptions to maintain your vault.', 'Let your agents to access BigBrain. (This is where the magic happens!).', 'Integrations help BigBrain pull the stuff that matters to you.'][step]}</p>
    </header>
    <div class="body">
      {#if step===0}
        {#if vault}<div class="chosen"><span>{vault}</span><span class="status"><i class="on"></i>Selected</span></div>{/if}
        <VaultPicker suggested={vault || '~/BigBrain'} onPick={path=>{vault=path;}} />
      {:else if step===1}
        <div class="rows">
          {#each providers as provider}
            <div class="row"><span class="name">{provider.name}</span><span class="status"><i class:on={connected.includes(provider.id)}></i>{connected.includes(provider.id)?'Connected':busy===provider.id?'Connecting…':'Not connected'}</span><button class:quiet={connected.includes(provider.id)} disabled={!!busy || connected.includes(provider.id)} onclick={()=>connect(provider.id,true)}>{connected.includes(provider.id)?'✓ Connected':busy===provider.id?'Connecting…':'Connect'}</button></div>
          {/each}
        </div>
      {:else if step===2}
        <div class="rows">
          {#each clients as client}
            <label class="client-row" class:unavailable={!connected.includes(client.id)}>
              <input type="checkbox" checked={granted.includes(client.id)} disabled={!connected.includes(client.id)} onchange={e=>selectClient(client.id,e.currentTarget.checked)} />
              <span class="name">{client.name}</span><span class="status">{!connected.includes(client.id)?'Not signed in':granted.includes(client.id)?'Access enabled':'Ready to connect'}</span>
            </label>
          {/each}
        </div>
      {:else}
        {#if added.length}
          <section aria-label="Your integrations" class="your-integrations"><h2>Your integrations</h2>
            {#each library.filter(i=>added.includes(i.id)) as integration}
              <div class="integration-account">
                <div class="row"><span class="name">{integration.name}</span><span class="status"><i class:on={paired.includes(integration.id)}></i>{paired.includes(integration.id)?'Connected':'Needs setup'}</span><button aria-expanded={configuring===integration.id} onclick={()=>configuring=configuring===integration.id?'':integration.id}>{configuring===integration.id?'Done':'Configure'}</button></div>
                {#if configuring===integration.id}
                  <div class="configuration">
                    {#if integration.id==='browser'}
                      <p>Save from your browser.</p><button class="primary" disabled={!!busy || paired.includes('browser')} onclick={()=>connect('browser')}>{paired.includes('browser')?'✓ Browser paired':busy==='browser'?'Pairing…':'Pair browser'}</button>
                    {:else}
                      <div class="account"><span>{paired.includes('granola')?'you@example.com':'Granola account'}</span><button disabled={!!busy || paired.includes('granola')} onclick={()=>connect('granola')}>{paired.includes('granola')?'✓ Connected':busy==='granola'?'Connecting…':'Connect'}</button></div>
                      <label class="check"><input type="checkbox" bind:checked={remember} />Automatic remembering</label>
                      {#if remember}<label class="rule">Remembering rule<textarea rows="3" bind:value={rule}></textarea></label>{/if}
                      <label class="check"><input type="checkbox" bind:checked={live} />Live access</label>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </section>
        {/if}
        <section aria-label="Integration library"><h2>Library</h2><div class="library">
          {#each library as integration}
            <article><span class="integration-symbol" aria-hidden="true">{integration.symbol}</span><h3>{integration.name}</h3><p>{integration.description}</p><button disabled={added.includes(integration.id)} onclick={()=>add(integration.id)}>{added.includes(integration.id)?'✓ Added':'+ Add'}</button></article>
          {/each}
        </div></section>
      {/if}
    </div>
    <footer>
      {#if step>0}<button class="back" disabled={!!busy} onclick={()=>go(step-1)}>← Back</button>{/if}
      <div class="forward">{#if step>=2}<button class="skip" disabled={!!busy} onclick={()=>{if(step===2){granted=[];void go(3);}else{void go(4);}}}>Skip</button>{/if}<button class="primary" disabled={!nextReady || !!busy} onclick={()=>{if(step===3){void go(4);}else{void go(step+1);}}}>{step===3?'Finish':'Next'} →</button></div>
    </footer>
  {/if}
  </div></div>
</main>

<style>
  .step-frame{overflow:clip;padding:4px;margin:-4px}
  .step-content{width:100%}
  :global(body){background:var(--bg);color:var(--text-strong);height:auto;overflow:auto}:global(#app){height:auto;min-height:100vh;overflow:visible}
  .study-bar{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 24px;border-bottom:1px solid var(--rule);font:var(--type-meta);color:var(--text-muted)}.study-bar button{padding:4px 10px;font:inherit}
  main{width:100%;max-width:836px;flex-shrink:0;margin:44px auto 80px;padding:0 28px}.brand{display:flex;align-items:center;gap:12px;font-size:19px;font-weight:600;margin-bottom:36px}
  nav{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:48px}nav button{display:flex;gap:10px;align-items:center;text-align:left;padding:0 0 12px;border:0;border-bottom:2px solid var(--rule);border-radius:0;color:var(--text-muted);font-size:14px}nav button.current{color:var(--text-strong);border-color:var(--text-strong)}nav button:disabled{opacity:1;cursor:default}nav button.done{color:var(--text-strong)}
  .number{display:grid;place-items:center;width:24px;height:24px;border:1px solid var(--rule);border-radius:50%;font-size:12px;flex:none}.current .number,.done .number{background:var(--text-strong);color:var(--bg);border-color:var(--text-strong)}
  .eyebrow{font:var(--type-meta);font-size:11px;text-transform:uppercase;letter-spacing:.18em;color:var(--text-muted);margin-bottom:12px}h1{font-family:var(--font-body);font-size:38px;font-weight:550;line-height:1.15;letter-spacing:-.025em;margin:0 0 18px}h1:focus{outline:0}.intro{font-size:17px;line-height:1.6;color:var(--text-muted);margin:0}
  .body{margin-top:36px;min-height:200px}h2{font-size:14px;font-weight:550;margin:0 0 14px}h3{font-size:17px;margin:0;font-weight:550}
  button,.button{font-family:inherit;font-size:15px;padding:10px 16px;border:1px solid var(--rule);border-radius:6px;background:transparent;color:var(--text-strong);cursor:pointer;text-decoration:none;line-height:1.4;white-space:nowrap}button:disabled{opacity:.5;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--activity);outline-offset:3px}.primary{background:var(--text-strong);color:var(--bg);border-color:var(--text-strong)}
  .row,.client-row{display:flex;align-items:center;gap:16px;padding:22px 0;border-bottom:1px solid var(--rule)}.row button{margin-left:auto;min-width:104px}.row button.quiet{border-color:transparent;opacity:1;color:var(--text-muted)}.name{font-size:18px}.status{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--text-muted)}.status i{width:7px;height:7px;border:1px solid currentColor;border-radius:50%}.status i.on{background:var(--activity);border-color:var(--activity)}
  .client-row{cursor:pointer}.client-row input,.check input{width:18px;height:18px;accent-color:var(--text-strong);margin:0}.client-row .status{margin-left:auto}.unavailable{opacity:.55;cursor:default}
  .library{display:grid;grid-template-columns:1fr 1fr;gap:16px}.library article{padding:24px;display:grid;grid-template-columns:1fr auto;gap:12px;border:1px solid var(--rule);border-radius:10px}.integration-symbol{font-size:24px;grid-column:1/-1}.library h3,.library p{grid-column:1/-1}.library p{font-size:14px;line-height:1.5;color:var(--text-muted);margin:0 0 10px}.library button{justify-self:start}
  .your-integrations{margin-bottom:30px}.integration-account{border:1px solid var(--rule);border-radius:8px;margin-bottom:12px;overflow:hidden}.integration-account .row{padding:16px 20px;border:0}.configuration{padding:20px;background:var(--well);border-top:1px solid var(--rule);display:flex;flex-direction:column;align-items:flex-start;gap:20px}.configuration p{font-size:14px;color:var(--text-muted);margin:0}.account{display:flex;align-items:center;justify-content:space-between;width:100%;gap:16px;font-size:14px}.check{display:flex;align-items:center;gap:10px;font-size:14px}.rule{display:grid;gap:10px;width:100%;font-size:13px;color:var(--text-muted)}textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:95px;font:inherit;line-height:1.5;color:var(--text-strong);padding:12px;background:var(--bg);border:1px solid var(--rule);border-radius:4px}
  footer{display:flex;align-items:center;gap:16px;border-top:1px solid var(--rule);margin-top:40px;padding-top:24px}.forward{display:flex;gap:12px;margin-left:auto}.back,.skip{border-color:transparent;color:var(--text-muted)}.chosen{display:flex;justify-content:space-between;gap:20px;border:1px solid var(--rule);border-radius:6px;padding:16px;margin-bottom:12px;font-size:14px;overflow-wrap:anywhere}
  .finished dl{margin:32px 0;display:grid;gap:16px;font-size:15px}.finished dl div{display:grid;grid-template-columns:130px 1fr;gap:20px}dt{color:var(--text-muted)}dd{margin:0}.finished .button{display:inline-block}
  @media(max-width:600px){main{padding:0 20px;margin-top:24px}nav{gap:6px;margin-bottom:32px}nav button{font-size:12px;gap:6px}.number{width:20px;height:20px}h1{font-size:30px}.library{grid-template-columns:1fr}.row{flex-wrap:wrap;gap:10px}.client-row{flex-wrap:wrap}.client-row .status{width:100%;margin-left:28px}.status{font-size:12px}.intro{font-size:15px}.study-bar{font-size:11px;padding:10px 16px}}
</style>
