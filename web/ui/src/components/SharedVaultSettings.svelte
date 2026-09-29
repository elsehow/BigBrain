<script lang="ts">
 import InclusionRuleEditor from './InclusionRuleEditor.svelte';
 import {parseMentions} from '../../../../lib/pilotMentions';
 import {onMount} from 'svelte';
 import {gotoNote} from '../lib/store.svelte';
 import SettingsPage from './SettingsPage.svelte';
 import {sharedSettings,reloadSharedConnections} from '../lib/sharedSettings.svelte';
 import {vaultFetch} from '../lib/vaultScope';
 import type {Contribution} from '../../../../lib/sharedRules';
 let data=$state<{evaluator?:string;name:string;identity:{display:string;permissions:string[];vault?:{recommended_rules?:{id:string;text:string;mentions:string[]}[]}};rule:{text:string;error?:string;lastRun?:string}|null;items:Contribution[]}|null>(null);
 const activeItems=$derived(data?.items.filter(item=>item.status==='active')??[]);
 let editing=$state(false),draft=$state(''),busy=$state(false),notice=$state<{ok:boolean;text:string}|null>(null),tab=$state<'rule'|'added'>('rule'),invite=$state('');
 async function request(action:string,body?:unknown){const r=await vaultFetch('/api/shared-settings'+(action?'/'+action:'')+(action?'?connection='+encodeURIComponent(sharedSettings.selected):''),{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw Error(result.error??'Request failed');return result;}
 async function load(){if(!sharedSettings.selected){data=null;return;}const id=sharedSettings.selected;const result=await request('vault');if(id===sharedSettings.selected)data=result;}
 async function act(fn:()=>Promise<void>){if(busy)return;busy=true;notice=null;try{await fn()}catch(e){notice={ok:false,text:(e as Error).message}}finally{busy=false}}
 function invalidate(){}
 function edit(){draft=data?.rule?.text??'';editing=true;invalidate();}
 async function transition(item:Contribution){await request('withdraw',{id:item.id,version:item.version,request_id:crypto.randomUUID()});await load();notice={ok:true,text:item.other_contributors.length?'Your contribution was withdrawn. Others still share this source.':'Contribution withdrawn. Your personal original is retained.'};}
 function openDialog(d:HTMLDialogElement){d.showModal();}
 onMount(()=>{void reloadSharedConnections();});
 $effect(()=>{const id=sharedSettings.selected;if(id){editing=false;invalidate();data=null;void load().catch(e=>notice={ok:false,text:e.message});}});
</script>
{#snippet row(item:Contribution)}
 <div class="contribution"><div class="contribution-main"><button class="source-title" onclick={()=>{if(item.path)gotoNote(item.path)}}>{item.title}</button><small>You · {new Date(item.added_at).toLocaleDateString()}</small>{#if item.other_contributors.length}<small>Also shared by {item.other_contributors.join(', ')}</small>{/if}</div><div class="actions"><button class="settings-add" disabled={busy||!data?.identity.permissions.includes('write')} onclick={()=>act(()=>transition(item))}>Withdraw</button></div></div>
{/snippet}
<SettingsPage active="sharedVaultSettings" title={data?.name.toUpperCase()??'SHARED VAULTS'} {notice}>
 {#if data}
 <section class="settings-card"><div class="settings-card-main"><h2 class="settings-card-name">{data.name}</h2><small>{data.identity.display} · {data.identity.permissions.includes('write')?'Read and write':'Read only'}</small></div>
 <div class="settings-card-body">
 <div class="section-tabs"><button class:on={tab==='rule'} onclick={()=>tab='rule'}>Inclusion rule</button><button class:on={tab==='added'} onclick={()=>tab='added'}>Added by you <small>{activeItems.length}</small></button></div>
 {#if tab==='added'}{#each activeItems as item (item.id)}{@render row(item)}{:else}<small>No shared sources.</small>{/each}
 {:else if !data.identity.permissions.includes('write')}<small>This membership is read-only.</small>
 {:else if editing}
 <InclusionRuleEditor target={{kind:'shared',id:sharedSettings.selected}} value={draft} onsave={()=>{editing=false;void load();notice={ok:true,text:'Inclusion rule saved.'}}} oncancel={()=>editing=false}/>
 {:else if data.rule}<div class="edit-actions"><small>Automatically adding new matches</small><div><button class="text-button" disabled={busy} onclick={edit}>Edit rule</button><button class="text-button" disabled={busy} onclick={()=>act(async()=>{await request('rule',{text:null});await load()})}>Remove rule</button></div></div><p>{#each parseMentions(data.rule.text) as part}{#if "text" in part}{part.text}{:else}<span class="rule-mention">@{part.mention.title}</span>{/if}{/each}</p>{#if data.rule.error}<small role="alert">{data.rule.error}</small>{/if}<details><summary>Recent contributions</summary>{#each activeItems.slice(0,5) as item (item.id)}{@render row(item)}{:else}<small>No contributions yet.</small>{/each}</details>
 {:else}<small>No inclusion rule.</small>{#each data.identity.vault?.recommended_rules??[] as suggestion}<div class="suggestion"><small>Suggested by {data.name}</small><p>{suggestion.text}</p><button class="settings-add" disabled={busy} onclick={()=>act(async()=>{const result=await request('recommendation',{id:suggestion.id});draft=result.text;editing=true;invalidate()})}>Use suggestion</button></div>{/each}<div><button class="settings-add" onclick={edit}>Add rule</button></div>{/if}
 </div></section>
 {:else}<small>{sharedSettings.selected?'Loading shared vault…':'Connect a shared vault to get started.'}</small>{/if}
</SettingsPage>
{#if sharedSettings.invite}<dialog use:openDialog onclose={()=>sharedSettings.invite=false}><form onsubmit={e=>{e.preventDefault();void act(async()=>{const c=await request('',{invite});invite='';sharedSettings.invite=false;await reloadSharedConnections();sharedSettings.selected=c.id;await load()})}}><h2>Connect a shared vault</h2><label>Invite link<input type="url" required bind:value={invite} placeholder="https://vault.example.org/invite#…" autocomplete="off"/></label>{#if notice&&!notice.ok}<small role="alert">{notice.text}</small>{/if}<div class="inline"><button class="settings-add" disabled={busy}>Connect</button><button class="text-button" type="button" disabled={busy} onclick={()=>{sharedSettings.invite=false;invite=''}}>Cancel</button></div></form></dialog>{/if}
<style>
 .source-title{font:var(--type-body);color:var(--text);text-align:left;border:0;padding:0;background:none;cursor:pointer;}.source-title:hover{text-decoration:underline;}
 .suggestion{display:grid;gap:14px;border:1px solid var(--rule);padding:18px;}
 .rule-mention{border-bottom:1px solid var(--rule);color:var(--text-strong);}
 small{font:var(--type-meta);color:var(--text-muted);line-height:1.6;}p{font:var(--type-body);line-height:1.6;margin:0;}label{display:grid;gap:8px;font:var(--type-meta);color:var(--text-muted);}input[type=url],button:disabled{opacity:.45;cursor:default;}.edit-actions,.edit-actions>div{display:flex;align-items:center;gap:18px;flex-wrap:wrap;}.edit-actions{justify-content:space-between;}.contribution{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:18px 0;border-bottom:1px solid var(--rule);font:var(--type-body);}.contribution-main,.actions{display:flex;flex-direction:column;gap:6px;}.actions{align-items:flex-end;}.section-tabs{display:flex;gap:28px;border-bottom:1px solid var(--rule);}.section-tabs button{font:var(--type-body);background:none;border:0;border-bottom:2px solid transparent;padding:0 0 12px;color:var(--text-muted);cursor:pointer;}.section-tabs button.on{border-bottom-color:var(--text);color:var(--text);}.section-tabs small{margin-left:8px;}.text-button{border:0;background:none;padding:0;color:var(--text);font:var(--type-meta);cursor:pointer;}summary{font:var(--type-meta);color:var(--text-muted);cursor:pointer;}dialog{width:min(560px,calc(100vw - 48px));box-sizing:border-box;padding:32px;background:var(--bg);color:var(--text);border:1px solid var(--rule);}dialog::backdrop{background:#0005;}form{display:grid;gap:24px;}h2{font:var(--type-heading);margin:0;}dialog .settings-add{font:var(--type-body);padding:8px 12px;border:1px solid var(--rule);color:var(--text);background:none;cursor:pointer;}
</style>
