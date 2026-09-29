<script lang="ts">
  import SettingsPage from '../components/SettingsPage.svelte';
  type Rule = { text: string };
  type Source = { id: number; title: string; from: string; addedToPersonal: string; matches: boolean; added?: string; addedAt?: string; manual?: boolean; contributedBy?: string; withdrawn?: boolean; otherContributors?: string[] };
  type Vault = { id: number; name: string; endpoint: string; writable: boolean; rule: Rule | null; sources: Source[] };
  let vaults = $state<Vault[]>([
    { id: 1, name: 'BigBrain', endpoint: 'vault.bigbrain.example', writable: true,
      rule: null,
      sources:[
        {id:1,title:'Notes on evidence and authorship',from:'Note · Today',addedToPersonal:'2026-09-29',matches:true},
        {id:2,title:'Designing a shared knowledge graph',from:'Article · Yesterday',addedToPersonal:'2026-09-28',matches:true},
        {id:3,title:'Import preview interaction study',from:'Document · Sep 24',addedToPersonal:'2026-09-24',matches:true},
        {id:4,title:'Local-first software: a reading list',from:'Note · Sep 22',addedToPersonal:'2026-09-22',matches:true,added:'Sep 23',addedAt:'2026-09-23',contributedBy:'member-you',otherContributors:['Mara']},
        {id:5,title:'How readers choose what to read next',from:'Article · Sep 20',addedToPersonal:'2026-09-20',matches:false},
        {id:6,title:'A small experiment in discovery',from:'Article · Sep 18',addedToPersonal:'2026-09-18',matches:false,added:'Sep 21',addedAt:'2026-09-21',contributedBy:'member-you',manual:true}]},
    { id:2,name:'Field notes',endpoint:'notes.example.org',writable:false,rule:null,sources:[] }
  ]);
  let selected = $state<number|null>(1), tab = $state<'rule'|'added'>('rule'), preview = $state(false);
  let checked = $state<number[]>([]), inspect = $state<Source|null>(null);
  let adding = $state(false), newName = $state(''), newEndpoint = $state(''), notice = $state(''), theme = $state('default');
  let allTime = $state(true), since = $state('2026-09-01');
  let editing = $state(false), draft = $state('');
  function editRule(v: Vault) { draft=v.rule?.text??''; editing=true; invalidatePreview(); }
  function saveRule(v: Vault) { v.rule={text:draft.trim()}; editing=false; invalidatePreview(); }
  function removeRule(v: Vault) { v.rule=null; cancelEdit(); notice='Rule removed. Previously added sources stay in this vault.'; }
  function cancelEdit() { editing=false; draft=''; invalidatePreview(); }
  let nextId = 10;
  function chooseVault(id: number) { selected=id; editing=false; draft=''; adding=false; tab='rule'; preview=false; allTime=true; since='2026-09-01'; checked=[]; inspect=null; notice=''; }
  const sidebarItems = $derived([
    {label:'Personal',selected:!adding&&selected===0,onselect:()=>chooseVault(0)},
    ...vaults.map(v=>({label:v.name,selected:!adding&&selected===v.id,onselect:()=>chooseVault(v.id)})),
    {label:'+ Connect vault',selected:adding,onselect:()=>{adding=true;notice='';}}
  ]);
  const viewerId = 'member-you';
  function withdraw(v: Vault, s: Source) {
    if(!v.writable||s.contributedBy!==viewerId)return;
    s.withdrawn=true; invalidatePreview();
    notice=s.otherContributors?.length?'Your contribution was withdrawn. Other members still share this source.':'Contribution withdrawn. Your personal original is retained.';
  }
  function restore(v: Vault, s: Source) {
    if(!v.writable||s.contributedBy!==viewerId)return;
    s.withdrawn=false; s.added='Just now'; s.addedAt=new Date().toISOString(); invalidatePreview(); notice='Your contribution was restored.';
  }
  function matchesInRange(v: Vault) { return v.sources.filter(s=>s.matches&&(allTime||s.addedToPersonal>=since)); }
  function showPreview(v: Vault) { preview=true; checked=matchesInRange(v).filter(s=>!s.added).map(s=>s.id); notice=''; }
  function invalidatePreview() { preview=false; checked=[]; notice=''; }
  function importSelected(v: Vault) { const n=checked.length; for(const s of v.sources)if(checked.includes(s.id)&&!s.added){s.added='Just now';s.addedAt=new Date().toISOString();s.contributedBy=viewerId;} checked=[];notice=`${n} ${n===1?'source added':'sources added'} to ${v.name}`;tab='added';preview=false; }
  function addVault(e: SubmitEvent) { e.preventDefault();const id=nextId++;vaults.push({id,name:newName,endpoint:newEndpoint,writable:true,rule:null,sources:[]});chooseVault(id);newName='';newEndpoint='';adding=false;tab='rule';notice='Sample connection added'; }
  $effect(()=>{ document.documentElement.dataset.theme=theme; });
</script>

{#snippet contribution(v: Vault, source: Source)}
  <div class="contribution" class:withdrawn={source.withdrawn}>
    <div class="contribution-main"><button class="source-title" onclick={()=>inspect=source}>{source.title}<small>You · {source.manual?'Added manually':'Inclusion rule'} · {source.added}</small></button>
      {#if source.withdrawn}<p class="quiet">Won’t be added again unless you restore it.</p>{/if}
      {#if source.otherContributors?.length}<p class="quiet">Also shared by {source.otherContributors.join(', ')}</p>{/if}
    </div>
    <div class="added-status"><span>{source.withdrawn?'Withdrawn':'Added'}</span>
      {#if source.contributedBy===viewerId && v.writable}<button class="text-button" aria-label={`${source.withdrawn?'Restore contribution':'Withdraw from vault'}: ${source.title}`} onclick={()=>source.withdrawn?restore(v,source):withdraw(v,source)}>{source.withdrawn?'Restore':'Withdraw'}</button>{/if}
    </div>
  </div>
{/snippet}

<div class="workbench-bar"><span>Vaults settings · interactive study</span><div><label>Theme <select bind:value={theme}><option value="default">Light</option><option value="web">Web blue</option><option value="dusk">Dusk</option></select></label><button onclick={()=>location.reload()}>Reset</button></div></div>
<main>
<SettingsPage active="vaultSettings" title={adding?'CONNECT VAULT':selected===0?'PERSONAL':vaults.find(v=>v.id===selected)?.name.toUpperCase()??'VAULT'} notice={notice?{ok:true,text:notice}:null}
  extraSection={{label:'VAULTS',active:true,items:sidebarItems}}>
  <section class="settings-list" aria-label="Vaults">
    {#if !adding && selected===0}<div class="settings-card personal">
      <div class="settings-card-row"><div class="settings-card-main"><h2 class="settings-card-name">Personal</h2><span class="settings-item-note">Only you · Default for new sources</span></div><span class="local">On this device</span></div>
      <p class="quiet personal-note">Your personal sources are private. Choose a shared vault in the sidebar to manage what you contribute.</p>
    </div>{/if}
    {#each vaults.filter(v=>!adding&&v.id===selected) as v (v.id)}
    <section class="settings-card" aria-label={`${v.name} vault`}>
      <div class="settings-card-row">
        <div class="settings-card-main"><h2 class="settings-card-name">{v.name}</h2>
          <span class="settings-status"><i class="ready"></i>{v.writable?'Owner · Read and write':'Member · Read only'}<code>{v.endpoint}</code></span>
        </div>
      </div>
      <div class="settings-card-body">
        {#if !v.writable}<p class="quiet">Everything in this vault is available in your search and graph. Read-only access doesn’t allow contributions.</p>
        {:else}
        <div class="section-tabs" role="tablist" aria-label={`${v.name} contributions`}>
          <button role="tab" aria-selected={tab==='rule'} onclick={()=>{tab='rule';notice='';}}>Inclusion rule</button>
          <button role="tab" aria-selected={tab==='added'} onclick={()=>{tab='added';notice='';}}>Added by you <span>{v.sources.filter(s=>s.added&&s.contributedBy===viewerId&&!s.withdrawn).length}</span></button>
        </div>
        {#if tab==='rule'}
          {#if !v.rule && !editing}
            <p class="quiet">No inclusion rule.</p>
            <div><button class="settings-add" onclick={()=>editRule(v)}>Add rule</button></div>
          {:else}
          <section class="rule" aria-label="Inclusion rule">
            {#if editing}
              <div class="rule-edit"><label>Include sources that…<textarea rows="4" bind:value={draft} oninput={invalidatePreview} placeholder="Describe which sources belong in this vault."></textarea></label></div>
            {:else if v.rule}
              <div class="rule-heading">
                <span class="quiet">Automatically adding new matches</span>
                <div class="edit-actions"><button class="text-button" onclick={()=>editRule(v)}>Edit rule</button><button class="text-button" onclick={()=>removeRule(v)}>Remove rule</button></div>
              </div>
              <p class="rule-text">{v.rule.text}</p>
              <details class="recent-items">
                <summary>Recently added by this rule</summary>
                {#each v.sources.filter(s=>s.added&&!s.manual&&s.contributedBy===viewerId).sort((a,b)=>(b.addedAt??'').localeCompare(a.addedAt??'')).slice(0,5) as source (source.id)}
                  {@render contribution(v, source)}
                {:else}<p class="quiet">No items added by this rule yet.</p>{/each}
              </details>
            {/if}
            {#if editing}
            <div class="test-range">
              <label class="all-time"><input type="checkbox" bind:checked={allTime} onchange={invalidatePreview}/>All time</label>
              <label class="date-range" class:inactive={allTime}>Added since<input type="date" bind:value={since} disabled={allTime} onchange={invalidatePreview}/></label>
            </div>
            <div class="rule-heading">
              <button class="settings-add" disabled={!(editing?draft:v.rule?.text??'').trim()||(!allTime&&!since)} onclick={()=>showPreview(v)}>Test rule</button>
              {#if editing}<div class="edit-actions"><button class="text-button" onclick={cancelEdit}>Cancel</button><button class="settings-add" disabled={!draft.trim()} onclick={()=>saveRule(v)}>{v.rule?'Save changes':'Save and enable'}</button></div>{/if}
            </div>
            {#if preview}
              <div class="matches">
                <p class="quiet">{matchesInRange(v).filter(s=>!s.added).length} not yet added · {matchesInRange(v).filter(s=>s.added&&!s.withdrawn).length} already added · {matchesInRange(v).filter(s=>s.withdrawn).length} withdrawn</p>
                {#each matchesInRange(v).filter(s=>!s.added) as source (source.id)}
                  <div class="source-row"><input type="checkbox" aria-label={`Select ${source.title}`} checked={checked.includes(source.id)} onchange={e=>checked=e.currentTarget.checked?[...checked,source.id]:checked.filter(id=>id!==source.id)}/><button class="source-title" onclick={()=>inspect=source}>{source.title}<small>{source.from}</small></button></div>
                {:else}<p class="quiet">No new matches to import.</p>{/each}
                {#if matchesInRange(v).some(s=>!s.added)}<div class="import-row"><button class="settings-add" disabled={!checked.length} onclick={()=>importSelected(v)}>Import {checked.length} {checked.length===1?'source':'sources'} to {v.name}</button><span class="quiet">Personal originals stay in your vault.</span></div>{/if}
              </div>
            {/if}
            {/if}
          </section>
          {/if}
        {:else}
          <p class="quiet">Sources you’ve contributed from Personal, through this rule or by hand.</p>
          {#each v.sources.filter(s=>s.added&&s.contributedBy===viewerId).sort((a,b)=>(b.addedAt??'').localeCompare(a.addedAt??'')) as source (source.id)}
            {@render contribution(v, source)}
          {:else}<p class="quiet">You haven’t contributed any sources yet.</p>{/each}
        {/if}
        {/if}
      </div>
    </section>
    {/each}
    {#if adding}
      <form class="connect" onsubmit={addVault}><h2>Connect a shared vault</h2><label>Name<input required bind:value={newName} placeholder="Research group"/></label><label>Server address<input type="url" required bind:value={newEndpoint} placeholder="https://vault.example.org"/></label><label>Member credential<input type="password" placeholder="Sample credential" autocomplete="off"/></label><div><button class="settings-add" type="submit">Connect</button> <button class="text-button" type="button" onclick={()=>adding=false}>Cancel</button></div></form>
    {/if}
  </section>
</SettingsPage>
</main>
<footer>Component workbench · Sample data, matches and imports · SettingsPage + SettingsRail · Based on ce998be / main 9686f88</footer>
{#if inspect}<div class="scrim" role="presentation" onclick={e=>{if(e.target===e.currentTarget)inspect=null;}}><div class="source-preview" role="dialog" aria-modal="true" aria-label="Source preview" tabindex="-1" onkeydown={e=>{if(e.key==='Escape')inspect=null;}}><button class="close" onclick={()=>inspect=null} aria-label="Close source preview">×</button><span class="quiet">Personal → {vaults.find(v=>v.id===selected)?.name}</span><h2>{inspect.title}</h2><p>This sample source explores how evidence, attribution, and shared knowledge can work together in a personal knowledge tool.</p><p class="quiet">{inspect.withdrawn?'Your contribution is withdrawn. Your personal original is retained.':inspect.added?`Added ${inspect.added}. The personal original is retained.`:'This source has not been contributed yet.'}</p></div></div>{/if}
<style>
  :global(body){margin:0;background:var(--bg);color:var(--text);} main{padding:26px 0 50px;} .personal-note{margin-top:24px;}
  .workbench-bar{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--rule);padding:14px 32px;font:var(--type-meta);color:var(--text-muted);} .workbench-bar>div{display:flex;gap:20px;align-items:center;} .workbench-bar button, select{font:inherit;background:var(--bg);color:var(--text);border:1px solid var(--rule);padding:4px 8px;}footer{padding:18px 32px;font:var(--type-meta);color:var(--text-faint);border-top:1px solid var(--rule);}
  .local{font:var(--type-meta);color:var(--text-faint);padding-top:4px;}
  .section-tabs{display:flex;gap:28px;border-bottom:1px solid var(--rule);} .section-tabs button{padding:0 0 12px;border:0;border-bottom:2px solid transparent;background:none;color:var(--text-muted);font:var(--type-body);cursor:pointer;}.section-tabs button[aria-selected=true]{border-bottom-color:var(--text);color:var(--text-strong);} .section-tabs span{font:var(--type-meta);margin-left:8px;color:var(--text-faint);}
  .quiet{font:var(--type-meta);color:var(--text-muted);line-height:1.6;margin:0;} .rule{border-bottom:1px solid var(--rule);padding-bottom:22px;} .rule-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;}
  .contribution-main{display:grid;gap:7px;}.withdrawn .source-title{color:var(--text-muted);}
  .recent-items summary{font:var(--type-meta);color:var(--text-muted);cursor:pointer;}.recent-items[open] summary{margin-bottom:18px;}.recent-items .contribution{padding-top:12px;}
  .rule-text{font:var(--type-body);line-height:1.6;margin:20px 0 24px;}.edit-actions{display:flex;align-items:center;gap:18px;}
  .test-range{display:flex;align-items:center;gap:24px;margin:0 0 18px;flex-wrap:wrap;}.all-time{display:flex;align-items:center;gap:8px;}.date-range{white-space:nowrap;display:flex;align-items:center;gap:10px;}.date-range input{width:auto;}.date-range.inactive{opacity:.4;}

  .text-button{font:var(--type-meta);color:var(--text);background:none;border:0;padding:0;cursor:pointer;}.text-button:hover{text-decoration:underline;}.matches{margin-top:18px;border-left:2px solid var(--rule);padding-left:18px;}.source-row{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--rule);}input[type=checkbox]{accent-color:var(--text);width:15px;height:15px;}.source-title{display:flex;flex-direction:column;gap:5px;min-width:0;text-align:left;font:var(--type-body);color:var(--text);background:none;border:0;padding:0;cursor:pointer;}.source-title:hover{text-decoration:underline;}small{font:var(--type-meta);color:var(--text-muted);}.import-row{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:18px;}button:disabled{opacity:.4;cursor:default;}
  .contribution{display:flex;justify-content:space-between;gap:24px;padding:6px 0 20px;border-bottom:1px solid var(--rule);}.added-status{display:flex;flex-direction:column;gap:5px;align-items:flex-end;font:var(--type-meta);color:var(--text);white-space:nowrap;}.rule-edit,.connect{display:grid;gap:16px;margin:18px 0;}label{display:grid;gap:7px;font:var(--type-meta);color:var(--text-muted);}input:not([type=checkbox]),textarea{box-sizing:border-box;width:100%;padding:10px;border:1px solid var(--rule);background:var(--bg);color:var(--text);font:var(--type-body);}textarea{resize:vertical;}.connect h2{font:var(--type-heading);margin:0;}
  .scrim{position:fixed;inset:0;background:#0005;display:grid;place-items:center;z-index:20;}.source-preview{position:relative;width:min(560px,calc(100vw - 80px));padding:32px;background:var(--bg);border:1px solid var(--rule);font:var(--type-body);line-height:1.6;}.source-preview h2{font:var(--type-heading);}.close{position:absolute;top:12px;right:16px;font-size:24px;color:var(--text);border:0;background:none;cursor:pointer;}
  @media(max-width:720px){.rule-heading{align-items:flex-start;flex-direction:column;}.workbench-bar{gap:12px;flex-wrap:wrap;} :global(.settings){gap:24px!important;padding-left:20px!important;padding-right:20px!important;}:global(.settings .rail){width:115px;} }
</style>
