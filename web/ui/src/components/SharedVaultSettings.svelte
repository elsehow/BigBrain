<script lang="ts">
 import SharedVaultMembers from './SharedVaultMembers.svelte';
 import InclusionRuleEditor from './InclusionRuleEditor.svelte';
 import InclusionBackfill from './InclusionBackfill.svelte';
 import {parseMentions} from '../../../../lib/pilotMentions';
 import {onMount} from 'svelte';
 import {app,gotoNote} from '../lib/store.svelte';
 import SettingsPage from './SettingsPage.svelte';
 import {sharedSettings,reloadSharedConnections,connectSharedInvite} from '../lib/sharedSettings.svelte';
 import {vaultFetch} from '../lib/vaultScope';
 import type {Contribution} from '../../../../lib/sharedRules';
 // A server's page: who is on it, then everything on it, searchable. The
 // server's one inclusion rule stays below until lenses replace it.
 type Note={id:string;title:string;by:string|null;at:string;path:string};
 type Person={handle:string;display:string;role:string};
 const FACES=7,PAGE=10;
 let data=$state<{evaluator?:string;name:string;endpoint:string;identity:{handle:string;role:string;display:string;permissions:string[];vault?:{recommended_rules?:{id:string;text:string;mentions:string[]}[]}};rule:{text:string;error?:string;lastRun?:string}|null;items:Contribution[]}|null>(null);
 let notes=$state<Note[]|null>(null),people=$state<Person[]>([]),peopleOpen=$state(false),peopleQuery=$state('');
 let tab=$state<'all'|'yours'>('all'),query=$state(''),hits=$state<Set<string>|null>(null),showAll=$state(false);
 const activeItems=$derived(data?.items.filter(item=>item.status==='active')??[]);
 const writable=$derived(!!data?.identity.permissions.includes('write'));
 const names=$derived(new Map(people.map(p=>[p.handle,p.handle===data?.identity.handle?'You':p.display])));
 const faces=$derived([...people].sort((a,b)=>Number(b.role==='owner')-Number(a.role==='owner')));
 const contributors=$derived(new Set(notes?.flatMap(n=>n.by?[n.by]:[])).size);
 const rows=$derived.by(()=>{
  const list=tab==='all'?(notes??[]).map(n=>({id:n.id,title:n.title,path:n.path,by:n.by?names.get(n.by)??n.by:'',at:n.at})):activeItems.map(i=>({id:i.insertion_id,title:i.title,path:i.path??'',at:i.added_at,item:i}));
  return hits?list.filter(r=>hits!.has(r.id)):list;
 });
 const shown=$derived(hits||showAll?rows:rows.slice(0,PAGE));
 let backfilling=$state(false),editing=$state(false),draft=$state(''),busy=$state(false),notice=$state<{ok:boolean;text:string}|null>(null),invite=$state('');
 async function request(action:string,body?:unknown){const r=await vaultFetch('/api/shared-settings'+(action?'/'+action:'')+(action?(action.includes('?')?'&':'?')+'connection='+encodeURIComponent(sharedSettings.selected):''),{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw Error(result.error??'Request failed');return result;}
 async function load(){if(!sharedSettings.selected){data=null;return;}const id=sharedSettings.selected;const result=await request('vault');if(id===sharedSettings.selected)data=result;}
 async function loadNotes(){const id=sharedSettings.selected;const result=await request('notes');if(id===sharedSettings.selected)notes=result.notes;}
 async function loadPeople(){const id=sharedSettings.selected;const result=await request('members');if(id===sharedSettings.selected)people=result.members.filter((m:Person&{pending?:boolean})=>!m.pending);}
 async function act(fn:()=>Promise<void>){if(busy)return;busy=true;notice=null;try{await fn()}catch(e){notice={ok:false,text:(e as Error).message}}finally{busy=false}}
 function edit(){draft=data?.rule?.text??'';editing=true;}
 async function withdraw(item:Contribution){await request('withdraw',{id:item.id,version:item.version,request_id:crypto.randomUUID()});await Promise.all([load(),loadNotes()]);notice={ok:true,text:item.other_contributors.length?'Your contribution was withdrawn. Others still share this source.':'Contribution withdrawn. Your personal original is retained.'};}
 let searchTimer:ReturnType<typeof setTimeout>|undefined;
 function search(q:string){query=q;clearTimeout(searchTimer);if(!q.trim()){hits=null;return;}searchTimer=setTimeout(()=>{const id=sharedSettings.selected;void request('search?q='+encodeURIComponent(q)).then(r=>{if(id===sharedSettings.selected&&query===q)hits=new Set(r.ids);}).catch(e=>notice={ok:false,text:e.message});},200);}
 const plural=(n:number,one:string,many:string)=>`${n} ${n===1?one:many}`;
 function openDialog(d:HTMLDialogElement){d.showModal();}
 onMount(()=>{void reloadSharedConnections();});
 $effect(()=>{const id=sharedSettings.selected;if(id){tab='all';query='';hits=null;showAll=false;editing=false;backfilling=false;data=null;notes=null;people=[];void load().catch(e=>notice={ok:false,text:e.message});void loadNotes().catch(e=>notice={ok:false,text:e.message});void loadPeople().catch(()=>{});}});
</script>
<SettingsPage active="sharedVaultSettings" title={data?.name.toUpperCase()??'SERVERS'} count={data?`${new URL(data.endpoint).host} · ${writable?'read and write':'read only'}`:undefined} {notice}>
 {#if data}
 {#if people.length}<button class="people" aria-label={people.length===1?'Show 1 person':`Show all ${people.length} people`} onclick={()=>peopleOpen=true}>
  {#each faces.slice(0,FACES) as p (p.handle)}<span class="face" class:admin={p.role==='owner'} title={p.role==='owner'?`${names.get(p.handle)}, admin`:names.get(p.handle)}>{(p.display.trim()[0]??'?').toUpperCase()}</span>{/each}
  {#if faces.length>FACES}<span class="face more">+{faces.length-FACES}</span>{/if}
 </button>{/if}
 <section class="server-notes" aria-label="On this server">
  <div class="notes-head"><h2>On this server</h2>{#if notes}<small>{plural(notes.length,'note','notes')} from {plural(contributors,'person','people')}</small>{/if}</div>
  <div class="filter" role="tablist" aria-label="Filter"><button role="tab" aria-selected={tab==='all'} onclick={()=>{tab='all';showAll=false}}>Everything <small>{notes?.length??''}</small></button><button role="tab" aria-selected={tab==='yours'} onclick={()=>{tab='yours';showAll=false}}>Yours <small>{activeItems.length}</small></button></div>
  <input class="search" type="search" aria-label="Search this server" placeholder="Search this server" autocomplete="off" value={query} oninput={e=>search(e.currentTarget.value)}/>
  <div class="table" class:yours={tab==='yours'}>
   <div class="row head"><span>Title</span>{#if tab==='all'}<span class="by">Added by</span>{/if}<span>Date</span>{#if tab==='yours'}<span></span>{/if}</div>
   {#each shown as r (r.id)}
    <div class="row"><button class="title" onclick={()=>{if(r.path)gotoNote(r.path)}}>{r.title}</button>{#if 'by' in r}<span class="by">{r.by}</span>{/if}<span>{r.at?new Date(r.at).toLocaleDateString():''}</span>{#if 'item' in r}<button class="text-button" disabled={busy||!writable} onclick={()=>act(()=>withdraw(r.item))}>Withdraw</button>{/if}</div>
   {:else}<div class="empty"><small>{query?'Nothing matches.':tab==='yours'?'No shared sources.':notes?'No notes yet.':'Loading…'}</small></div>{/each}
  </div>
  {#if !hits&&!showAll&&rows.length>PAGE}<button class="settings-add" onclick={()=>showAll=true}>Show all {rows.length}</button>{/if}
 </section>
 {#if writable}<section class="settings-card" aria-label="Inclusion rule"><div class="settings-card-main"><h2 class="settings-card-name">Inclusion rule</h2></div>
 <div class="settings-card-body">
 {#if editing}
 <InclusionRuleEditor target={{kind:'shared',id:sharedSettings.selected}} value={draft} onsave={()=>{editing=false;backfilling=true;void load();notice={ok:true,text:'Inclusion rule saved.'}}} oncancel={()=>editing=false}/>
 {:else if backfilling&&data.rule}{#key sharedSettings.selected}<InclusionBackfill connection={sharedSettings.selected} vaultName={data.name} onclose={added=>{backfilling=false;void load();if(added)notice={ok:true,text:`Added ${added} existing ${added===1?'note':'notes'} to ${data?.name}.`}}}/>{/key}
 {:else if data.rule}<div class="edit-actions"><small>Automatically adding new matches</small><div><button class="text-button" disabled={busy} onclick={()=>backfilling=true}>Add existing matches</button><button class="text-button" disabled={busy} onclick={edit}>Edit rule</button><button class="text-button" disabled={busy} onclick={()=>act(async()=>{await request('rule',{text:null});await load()})}>Remove rule</button></div></div><p>{#each parseMentions(data.rule.text) as part}{#if "text" in part}{part.text}{:else}<span class="rule-mention">@{part.mention.title}</span>{/if}{/each}</p>{#if data.rule.error}<small role="alert">{data.rule.error}</small>{/if}
 {:else}<small>No inclusion rule.</small>{#each data.identity.vault?.recommended_rules??[] as suggestion}<div class="suggestion"><small>Suggested by {data.name}</small><p>{suggestion.text}</p><button class="settings-add" disabled={busy} onclick={()=>act(async()=>{const result=await request('recommendation',{id:suggestion.id});draft=result.text;editing=true})}>Use suggestion</button></div>{/each}<div><button class="settings-add" onclick={edit}>Add rule</button></div>{/if}
 </div></section>{/if}
 {:else}<small>{sharedSettings.selected?'Loading server…':'Connect a server to get started.'}</small>{/if}
</SettingsPage>
{#if peopleOpen&&data}<dialog class="people-dialog" use:openDialog onclose={()=>{peopleOpen=false;peopleQuery='';void loadPeople().catch(()=>{});}} aria-label="People on {data.name}"><div class="dialog-head"><input type="search" aria-label="Search people" placeholder={`Search ${plural(people.length,'person','people')}`} autocomplete="off" bind:value={peopleQuery}/><button aria-label="Close" onclick={e=>e.currentTarget.closest('dialog')?.close()}>×</button></div>{#key sharedSettings.selected}<SharedVaultMembers vaultName={data.name} endpoint={data.endpoint} {request} filter={peopleQuery}/>{/key}</dialog>{/if}
{#if sharedSettings.invite}<dialog use:openDialog onclose={()=>sharedSettings.invite=false}><form onsubmit={e=>{e.preventDefault();void act(async()=>{const c=await connectSharedInvite(invite);await reloadSharedConnections();sharedSettings.selected=c.id;sharedSettings.invite=false;invite='';app.rev++})}}><h2>Connect a server</h2><label>Invite link<input type="url" required disabled={busy} bind:value={invite} placeholder="https://vault.example.org/invite#…" autocomplete="off"/></label>{#if notice&&!notice.ok}<small role="alert">{notice.text}</small>{/if}<div class="invite-actions"><button class="settings-add" disabled={busy||!invite.trim()}>Connect</button><button class="text-button" type="button" disabled={busy} onclick={()=>{sharedSettings.invite=false;invite=''}}>Cancel</button></div></form></dialog>{/if}
<style>
 .suggestion{display:grid;gap:14px;border:1px solid var(--rule);padding:18px;}
 .rule-mention{border-bottom:1px solid var(--rule);color:var(--text-strong);}
 small{font:var(--type-meta);color:var(--text-muted);line-height:1.6;}p{font:var(--type-body);line-height:1.6;margin:0;}label{display:grid;gap:8px;font:var(--type-meta);color:var(--text-muted);}button:disabled,input:disabled{opacity:.45;cursor:default;}.edit-actions,.edit-actions>div{display:flex;align-items:center;gap:18px;flex-wrap:wrap;}.edit-actions{justify-content:space-between;}.text-button{border:0;background:none;padding:0;color:var(--text);font:var(--type-meta);cursor:pointer;}dialog{width:min(520px,calc(100vw - 48px));box-sizing:border-box;padding:32px;background:var(--bg);color:var(--text);border:1px solid var(--rule);}dialog::backdrop{background:#0005;}
 /* who is here: the admin first and inverted, the rest behind +N */
 .people{display:flex;flex-wrap:wrap;gap:8px;align-self:flex-start;padding:0;border:0;background:none;cursor:pointer;margin-bottom:var(--sp-6);}
 .face{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;box-sizing:border-box;border:1px solid var(--text-muted);background:var(--bg);color:var(--text-strong);font:var(--type-meta);font-weight:600;}
 .face.admin{background:var(--text-strong);border-color:var(--text-strong);color:var(--bg);}
 .face.more{border-color:var(--rule);color:var(--text-muted);}
 .people:hover .face.more{border-color:var(--text-strong);color:var(--text-strong);}
 .people:focus-visible{outline:2px solid var(--text-muted);outline-offset:4px;}
 /* everything on the server */
 .server-notes{display:grid;gap:var(--sp-4);padding-bottom:var(--sp-7);min-width:0;}
 .notes-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 24px;}
 .filter{display:flex;gap:28px;border-bottom:1px solid var(--rule);}
 .filter button{font:var(--type-body);background:none;border:0;border-bottom:2px solid transparent;padding:0 0 12px;color:var(--text-muted);cursor:pointer;}
 .filter button[aria-selected=true]{border-bottom-color:var(--text);color:var(--text);}.filter small{margin-left:8px;}
 .search,.dialog-head input{appearance:none;-webkit-appearance:none;box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--rule);border-radius:0;padding:12px 14px;background:var(--well);color:var(--text-strong);font:var(--type-body);line-height:1.4;}
 .search::placeholder,.dialog-head input::placeholder{color:var(--text-muted);opacity:.65;}
 .search:focus-visible,.dialog-head input:focus-visible{outline:1px solid var(--text-muted);outline-offset:3px;}
 .table{display:grid;min-width:0;}
 .row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,160px) 110px;gap:16px;align-items:baseline;padding:12px 0;border-bottom:1px solid var(--rule);font:var(--type-body);}
 .yours .row{grid-template-columns:minmax(0,1fr) 110px 80px;}
 .row.head{font:var(--type-meta);color:var(--text-muted);padding-top:4px;}
 .row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-note);font:var(--type-meta);}
 .row .title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;border:0;padding:0;background:none;cursor:pointer;font:var(--type-body);color:var(--text-strong);}
 .row .title:hover{text-decoration:underline;text-underline-offset:3px;}
 .row .text-button{justify-self:end;}
 .empty{padding:18px 0;}
 .people-dialog{width:min(560px,calc(100vw - 32px));max-height:80vh;}
 .dialog-head{display:flex;align-items:center;gap:12px;margin-bottom:var(--sp-4);}
 .dialog-head button{flex:none;border:0;background:none;font-size:24px;line-height:1;padding:0 6px;color:var(--text-muted);cursor:pointer;}
 @media(max-width:600px){.row{grid-template-columns:minmax(0,1fr) 90px;}.row .by{display:none;}.yours .row{grid-template-columns:minmax(0,1fr) 90px 72px;}}
 .invite-actions{display:flex;align-items:center;justify-content:flex-end;gap:24px;}
 dialog form input{appearance:none;-webkit-appearance:none;box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--rule);border-radius:0;padding:12px 14px;background:var(--well);color:var(--text-strong);font:var(--type-body);line-height:1.4;}
 dialog form input::placeholder{color:var(--text-muted);opacity:.65;}
 dialog form input:focus-visible{outline:1px solid var(--text-muted);outline-offset:3px;}
 dialog .invite-actions .settings-add{padding:10px 18px;}form{display:grid;gap:24px;}h2{font:var(--type-heading);margin:0;}dialog .settings-add{font:var(--type-body);padding:8px 12px;border:1px solid var(--rule);color:var(--text);background:none;cursor:pointer;}
</style>
