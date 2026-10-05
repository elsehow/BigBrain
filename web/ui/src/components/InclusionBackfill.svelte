<script lang="ts">
 // Existing notes that match a saved rule (lib/inclusionBackfill.ts). Every thumbs
 // up or down teaches the rule; nothing is added until "Add".
 import {onDestroy,onMount} from 'svelte';
 import {vaultFetch} from '../lib/vaultScope';
 type Match={id:string;title:string;origin:string;excerpt:string;body:string;kept:boolean};
 type View={id:string;busy:boolean;scanned:number;total:number;failed:number;failure?:string;error?:string;added?:number;matches:Match[]};
 let {connection,vaultName,onclose}:{connection:string;vaultName:string;onclose:(added:number)=>void}=$props();
 let view=$state<View|null>(null),problem=$state(''),sending=$state(false),opened=$state<Match|null>(null),disposed=false;
 let fading=$state<Record<string,boolean>>({});
 async function request(action:string,body?:unknown){const r=await vaultFetch('/api/inclusion-backfill/'+action,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error??'Could not find existing matches.');return data;}
 async function follow(next:View){view=next;while(view?.busy&&!disposed){await new Promise(r=>setTimeout(r,800));if(disposed)return;view=await request('?id='+encodeURIComponent(next.id));}}
 async function start(){problem='';view=null;try{await follow(await request('start',{connection}));}catch(e){problem=(e as Error).message;}}
 onMount(()=>{void start();});
 onDestroy(()=>{disposed=true;});
 async function rate(m:Match,include:boolean){
  if(!view||sending)return;problem='';
  if(!include){fading={...fading,[m.id]:true};await new Promise(r=>setTimeout(r,260));}
  try{await follow(await request('rate',{id:view.id,source:m.id,include}));}catch(e){problem=(e as Error).message;}
  finally{const next={...fading};delete next[m.id];fading=next;}
 }
 async function add(){if(!view||sending||view.busy)return;sending=true;problem='';try{const r=await request('add',{id:view.id});onclose(r.added);}catch(e){problem=(e as Error).message;}finally{sending=false;}}
 function show(dialog:HTMLDialogElement){dialog.showModal();}
 const count=$derived(view?.matches.length??0);
 const status=$derived(!view?'Finding notes that match…':view.busy&&view.scanned<view.total?`Checking ${view.scanned} of ${view.total} likely notes…`:view.busy?'Updating matches from your ratings…':view.failed&&!count?`${view.failed} of ${view.total} likely ${view.total===1?'note':'notes'} couldn’t be checked, so matches may be missing.`:count?`${count} existing ${count===1?'note matches':'notes match'}. Thumbs down anything that doesn’t belong; each rating teaches the rule.`:'No existing notes match this rule.');
</script>
<div class="backfill" role="group" aria-label="Existing matches">
 <div class="heading"><span>Add existing notes to {vaultName}?</span></div>
 <p role="status" aria-live="polite">{status}</p>
 <div class="cards">
 {#each view?.matches??[] as m (m.id)}
  <article class:fading={fading[m.id]}>
   <div class="source"><small>{m.origin}</small><button class="title" onclick={()=>opened=m}>{m.title}</button><p>{m.excerpt}</p></div>
   <div class="judgments">
    <button aria-label={`Keep: ${m.title}`} title="Keep" class:chosen={m.kept} aria-pressed={m.kept} disabled={m.kept||!!fading[m.id]} onclick={()=>rate(m,true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11H3V10zM7 10l5-7c2 0 3 1 2 4l-1 3h6a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7"/></svg></button>
    <button aria-label={`Leave out: ${m.title}`} title="Leave out" disabled={!!fading[m.id]} onclick={()=>rate(m,false)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 14V3H3v11zM7 14l5 7c2 0 3-1 2-4l-1-3h6a2 2 0 0 0 2-2l-2-7a2 2 0 0 0-2-2H7"/></svg></button>
   </div>
  </article>
 {/each}
 </div>
 {#if problem||view?.error}<p role="alert">{problem||view?.error}</p>
 {:else if view&&!view.busy&&view.failed}<p role="alert">{view.failed===view.total?'':`${view.failed} ${view.failed===1?'note':'notes'} couldn’t be checked. `}{view.failure} <button class="retry" onclick={start}>Retry</button></p>{/if}
 <div class="footer"><button class="cancel" onclick={()=>onclose(0)}>Not now</button><button class="add" disabled={!view||view.busy||sending||!count} onclick={add}>{sending?'Adding…':count?`Add ${count} ${count===1?'note':'notes'}`:'Add'}</button></div>
</div>
{#if opened}
 <dialog use:show onclose={()=>opened=null} aria-label={opened.title}><div class="dialog-head"><small>{opened.origin}</small><button onclick={()=>opened=null} aria-label="Close source">×</button></div><h2>{opened.title}</h2><p class="body">{opened.body}</p></dialog>
{/if}
<style>
 .backfill{display:grid;gap:16px}.heading{font:var(--type-body);color:var(--text-strong)}
 button{cursor:pointer;color:var(--text-strong);background:transparent;border:1px solid var(--rule);font:var(--type-meta)}
 p{margin:0;font:var(--type-meta);line-height:1.6;color:var(--text-note)}[role=status]{color:var(--text-muted)}[role=alert]{color:var(--accent-2)}
 .cards{display:grid;gap:12px}article{display:flex;align-items:center;gap:24px;padding:20px;border:1px solid var(--rule);background:var(--bg);transition:opacity 260ms ease}article.fading{opacity:0;pointer-events:none}
 .source{flex:1;min-width:0;display:grid;gap:7px}small{font:var(--type-meta);color:var(--text-muted)}
 .title{text-align:left;padding:0;border:0;font:var(--type-body);line-height:1.4;justify-self:start}.title:hover{text-decoration:underline;text-underline-offset:3px}
 .judgments{display:flex;gap:8px}.judgments button{width:40px;height:40px;display:grid;place-items:center}.judgments svg{width:19px;height:19px}
 .judgments button:hover{border-color:var(--text-strong);background:var(--well)}.judgments button.chosen,.judgments button.chosen:hover{background:var(--text-strong);color:var(--bg);border-color:var(--text-strong)}.judgments button:disabled{cursor:default}
 button:focus-visible{outline:2px solid var(--text-strong);outline-offset:3px}
 .footer{display:flex;justify-content:space-between;align-items:center;gap:20px;padding-top:4px}
 .add{padding:8px 18px;background:var(--text-strong);color:var(--bg);border-color:var(--text-strong)}.add:disabled{opacity:.3;cursor:default}
 .retry{background:none;border:0;padding:0;font:inherit;color:inherit;text-decoration:underline}
 .cancel{background:none;border:0;padding:0;font:var(--type-meta);color:var(--text-muted);text-decoration:underline}
 dialog{box-sizing:border-box;width:min(640px,calc(100vw - 32px));max-height:80vh;padding:28px;border:1px solid var(--rule);background:var(--bg);color:var(--text-strong)}dialog::backdrop{background:#0007}.dialog-head{display:flex;justify-content:space-between;align-items:center}.dialog-head button{border:0;font-size:24px;padding:0 6px}h2{font:var(--type-heading);line-height:1.35;margin:22px 0}.body{white-space:pre-wrap;font:var(--type-body);line-height:1.7}
 @media(prefers-reduced-motion:reduce){article{transition:none}article.fading{opacity:1}}
 @media(max-width:600px){article{padding:16px;gap:16px;align-items:flex-start}.judgments{flex-direction:column}}
</style>
