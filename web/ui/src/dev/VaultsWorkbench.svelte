<script lang="ts">
  import SettingsPage from '../components/SettingsPage.svelte';
  import { tooltip } from '../lib/tooltip';
  type Rule = { id: number; name: string; text: string; enabled: boolean };
  type Source = { id: number; title: string; from: string; rule: number; added?: string; manual?: boolean };
  type Vault = { id: number; name: string; endpoint: string; writable: boolean; rules: Rule[]; sources: Source[] };
  let vaults = $state<Vault[]>([
    { id: 1, name: 'BigBrain', endpoint: 'vault.bigbrain.example', writable: true,
      rules: [
        {id:1, name:'BigBrain development', text:'Sources about BigBrain’s design, implementation, or research. Exclude personal conversations.', enabled:true},
        {id:2, name:'Reading and recommendations', text:'Articles about personal knowledge tools, reading interfaces, and recommender systems.', enabled:false}],
      sources:[
        {id:1,title:'Notes on evidence and authorship',from:'Note · Today',rule:1},
        {id:2,title:'Designing a shared knowledge graph',from:'Article · Yesterday',rule:1},
        {id:3,title:'Import preview interaction study',from:'Document · Sep 24',rule:1},
        {id:4,title:'Local-first software: a reading list',from:'Note · Sep 22',rule:1,added:'Sep 23'},
        {id:5,title:'How readers choose what to read next',from:'Article · Sep 20',rule:2},
        {id:6,title:'A small experiment in discovery',from:'Article · Sep 18',rule:2,added:'Sep 21',manual:true}]},
    { id:2,name:'Field notes',endpoint:'notes.example.org',writable:false,rules:[],sources:[] }
  ]);
  let selected = $state<number|null>(1), tab = $state<'rules'|'added'>('rules'), preview = $state<number|null>(null);
  let checked = $state<number[]>([]), edit = $state<number|null>(null), inspect = $state<Source|null>(null);
  let adding = $state(false), newName = $state(''), newEndpoint = $state(''), notice = $state(''), theme = $state('default');
  let nextId = 10;
  function chooseVault(id: number) { selected=id; adding=false; tab='rules'; preview=null; edit=null; checked=[]; inspect=null; notice=''; }
  const sidebarItems = $derived([
    {label:'Personal',selected:!adding&&selected===0,onselect:()=>chooseVault(0)},
    ...vaults.map(v=>({label:v.name,selected:!adding&&selected===v.id,onselect:()=>chooseVault(v.id)})),
    {label:'+ Connect vault',selected:adding,onselect:()=>{adding=true;notice='';}}
  ]);
  function showPreview(v: Vault, r: Rule) { preview=r.id; checked=v.sources.filter(s=>s.rule===r.id&&!s.added).map(s=>s.id); notice=''; }
  function importSelected(v: Vault) { const n=checked.length; for(const s of v.sources)if(checked.includes(s.id)&&!s.added)s.added='Just now'; checked=[];notice=`${n} ${n===1?'source added':'sources added'} to ${v.name}`;tab='added';preview=null; }
  function addVault(e: SubmitEvent) { e.preventDefault();const id=nextId++;vaults.push({id,name:newName,endpoint:newEndpoint,writable:true,rules:[],sources:[]});selected=id;newName='';newEndpoint='';adding=false;tab='rules';notice='Sample connection added'; }
  function addRule(v: Vault) { const id=nextId++;v.rules.push({id,name:'New inclusion rule',text:'',enabled:false});edit=id; }
  $effect(()=>{ document.documentElement.dataset.theme=theme; });
</script>

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
          <button role="tab" aria-selected={tab==='rules'} onclick={()=>{tab='rules';notice='';}}>Inclusion rules <span>{v.rules.length}</span></button>
          <button role="tab" aria-selected={tab==='added'} onclick={()=>{tab='added';notice='';}}>Added by you <span>{v.sources.filter(s=>s.added).length}</span></button>
        </div>
        {#if tab==='rules'}
          <p class="quiet">Rules select sources from Personal. Import existing matches, or add new matches automatically.</p>
          {#each v.rules as rule (rule.id)}
          <section class="rule" aria-label={rule.name}>
            <div class="rule-heading"><button class="rule-name" onclick={()=>edit=edit===rule.id?null:rule.id}>{rule.name}</button>
              <button class="toggle" role="switch" aria-checked={rule.enabled} aria-label={`Automatically add new sources: ${rule.name}`} onclick={()=>rule.enabled=!rule.enabled} use:tooltip={'Applies to new sources only. Existing contributions stay shared.'}><span class="track"><i></i></span>New sources {rule.enabled?'on':'off'}</button>
            </div>
            {#if edit===rule.id}
              <div class="rule-edit"><label>Name<input bind:value={rule.name}/></label><label>Include sources that…<textarea rows="3" bind:value={rule.text}></textarea></label><button class="settings-add" onclick={()=>{edit=null;preview=null;}}>Done</button></div>
            {:else}<p class="rule-description">{rule.text||'Describe which sources belong in this vault.'}</p>{/if}
            <button class="text-button" onclick={()=>preview===rule.id?preview=null:showPreview(v,rule)}>{preview===rule.id?'Hide matches':'Review existing matches'} <span aria-hidden="true">{preview===rule.id?'↑':'→'}</span></button>
            {#if preview===rule.id}
              <div class="matches">
                <p class="quiet">{v.sources.filter(s=>s.rule===rule.id&&!s.added).length} not yet added · {v.sources.filter(s=>s.rule===rule.id&&s.added).length} already added</p>
                {#each v.sources.filter(s=>s.rule===rule.id&&!s.added) as source (source.id)}
                  <div class="source-row"><input type="checkbox" aria-label={`Select ${source.title}`} checked={checked.includes(source.id)} onchange={e=>checked=e.currentTarget.checked?[...checked,source.id]:checked.filter(id=>id!==source.id)}/><button class="source-title" onclick={()=>inspect=source}>{source.title}<small>{source.from}</small></button></div>
                {:else}<p class="quiet">No new matches to import.</p>{/each}
                {#if v.sources.some(s=>s.rule===rule.id&&!s.added)}<div class="import-row"><button class="settings-add" disabled={!checked.length} onclick={()=>importSelected(v)}>Import {checked.length} {checked.length===1?'source':'sources'} to {v.name}</button><span class="quiet">Personal originals stay in your vault.</span></div>{/if}
              </div>
            {/if}
          </section>
          {/each}
          <button class="settings-add" onclick={()=>addRule(v)}>Add inclusion rule</button>
        {:else}
          <p class="quiet">Sources you’ve contributed from Personal, through rules or by hand.</p>
          {#each v.sources.filter(s=>s.added).reverse() as source (source.id)}
            <div class="contribution"><button class="source-title" onclick={()=>inspect=source}>{source.title}<small>{source.manual?'Added manually':v.rules.find(r=>r.id===source.rule)?.name}</small></button><span class="added-status">Added<small>{source.added}</small></span></div>
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
<footer>Component workbench · Sample data and simulated imports · SettingsPage + SettingsRail · Based on 02b206f / main 9686f88</footer>
{#if inspect}<div class="scrim" role="presentation" onclick={e=>{if(e.target===e.currentTarget)inspect=null;}}><div class="source-preview" role="dialog" aria-modal="true" aria-label="Source preview" tabindex="-1" onkeydown={e=>{if(e.key==='Escape')inspect=null;}}><button class="close" onclick={()=>inspect=null} aria-label="Close source preview">×</button><span class="quiet">Personal → {vaults.find(v=>v.id===selected)?.name}</span><h2>{inspect.title}</h2><p>This sample source explores how evidence, attribution, and shared knowledge can work together in a personal knowledge tool.</p><p class="quiet">{inspect.added?`Added ${inspect.added}. The personal original is retained.`:'This source has not been contributed yet.'}</p></div></div>{/if}
<style>
  :global(body){margin:0;background:var(--bg);color:var(--text);} main{padding:26px 0 50px;} .personal-note{margin-top:24px;}
  .workbench-bar{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--rule);padding:14px 32px;font:var(--type-meta);color:var(--text-muted);} .workbench-bar>div{display:flex;gap:20px;align-items:center;} .workbench-bar button, select{font:inherit;background:var(--bg);color:var(--text);border:1px solid var(--rule);padding:4px 8px;}footer{padding:18px 32px;font:var(--type-meta);color:var(--text-faint);border-top:1px solid var(--rule);}
  .local{font:var(--type-meta);color:var(--text-faint);padding-top:4px;}
  .section-tabs{display:flex;gap:28px;border-bottom:1px solid var(--rule);} .section-tabs button{padding:0 0 12px;border:0;border-bottom:2px solid transparent;background:none;color:var(--text-muted);font:var(--type-body);cursor:pointer;}.section-tabs button[aria-selected=true]{border-bottom-color:var(--text);color:var(--text-strong);} .section-tabs span{font:var(--type-meta);margin-left:8px;color:var(--text-faint);}
  .quiet{font:var(--type-meta);color:var(--text-muted);line-height:1.6;margin:0;} .rule{border-bottom:1px solid var(--rule);padding-bottom:22px;} .rule-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;} .rule-name{font:var(--type-body);font-weight:500;color:var(--text-strong);background:none;border:0;padding:0;cursor:pointer;text-align:left;}.rule-description{font:var(--type-body);color:var(--text-muted);line-height:1.55;margin:10px 0 14px;max-width:520px;}
  .toggle{display:flex;align-items:center;gap:8px;background:none;border:0;padding:0;font:var(--type-meta);color:var(--text-muted);cursor:pointer;white-space:nowrap;}.track{width:27px;height:15px;border:1px solid var(--text-faint);display:flex;align-items:center;padding:2px;box-sizing:border-box;}.track i{display:block;width:9px;height:9px;background:var(--text-faint);}.toggle[aria-checked=true] .track{border-color:var(--activity);}.toggle[aria-checked=true] i{background:var(--activity);margin-left:auto;}
  .text-button{font:var(--type-meta);color:var(--text);background:none;border:0;padding:0;cursor:pointer;}.text-button:hover{text-decoration:underline;}.text-button span{margin-left:8px;}.matches{margin-top:18px;border-left:2px solid var(--rule);padding-left:18px;}.source-row{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--rule);}input[type=checkbox]{accent-color:var(--text);width:15px;height:15px;}.source-title{display:flex;flex-direction:column;gap:5px;min-width:0;text-align:left;font:var(--type-body);color:var(--text);background:none;border:0;padding:0;cursor:pointer;}.source-title:hover{text-decoration:underline;}small{font:var(--type-meta);color:var(--text-muted);}.import-row{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:18px;}button:disabled{opacity:.4;cursor:default;}
  .contribution{display:flex;justify-content:space-between;gap:24px;padding:6px 0 20px;border-bottom:1px solid var(--rule);}.added-status{display:flex;flex-direction:column;gap:5px;align-items:flex-end;font:var(--type-meta);color:var(--text);white-space:nowrap;}.rule-edit,.connect{display:grid;gap:16px;margin:18px 0;}label{display:grid;gap:7px;font:var(--type-meta);color:var(--text-muted);}input:not([type=checkbox]),textarea{box-sizing:border-box;width:100%;padding:10px;border:1px solid var(--rule);background:var(--bg);color:var(--text);font:var(--type-body);}textarea{resize:vertical;}.connect h2{font:var(--type-heading);margin:0;}
  .scrim{position:fixed;inset:0;background:#0005;display:grid;place-items:center;z-index:20;}.source-preview{position:relative;width:min(560px,calc(100vw - 80px));padding:32px;background:var(--bg);border:1px solid var(--rule);font:var(--type-body);line-height:1.6;}.source-preview h2{font:var(--type-heading);}.close{position:absolute;top:12px;right:16px;font-size:24px;color:var(--text);border:0;background:none;cursor:pointer;}
  @media(max-width:720px){.rule-heading{align-items:flex-start;flex-direction:column;}.workbench-bar{gap:12px;flex-wrap:wrap;} :global(.settings){gap:24px!important;padding-left:20px!important;padding-right:20px!important;}:global(.settings .rail){width:115px;} }
</style>
