<script lang="ts">
 import {onDestroy} from "svelte";
 export interface RuleExample {id:string;title:string;origin:string;excerpt:string;body:string}
 export interface PickableNote {id:string;title:string;origin:string}
 let {items,onjudge,ondone,ready=true,retesting=false,status="",showExamples=true,picked=[],search,onpick}:{items:RuleExample[];onjudge:(id:string,include:boolean)=>void;ondone:()=>void;ready?:boolean;retesting?:boolean;status?:string;showExamples?:boolean;
  /** Notes added by hand: shown first, thumbs up already chosen. */
  picked?:RuleExample[];search?:(q:string,signal:AbortSignal)=>Promise<PickableNote[]>;onpick?:(id:string)=>void}=$props();
 let picking=$state(false),query=$state(''),found=$state<PickableNote[]>([]),active=$state(0),searchFailed=$state(false),lookup:AbortController|undefined,lookupTimer:ReturnType<typeof setTimeout>|undefined;
 let opened=$state<RuleExample|null>(null);
 let pending=$state<Record<string,{include:boolean;fading:boolean}>>({});
 const timers=new Map<string,ReturnType<typeof setTimeout>>();
 function judge(id:string,include:boolean){
  if(pending[id]||retesting)return;
  pending={...pending,[id]:{include,fading:false}};
  timers.set(id,setTimeout(()=>{
   pending={...pending,[id]:{include,fading:true}};
   timers.set(id,setTimeout(()=>finish(id),260));
  },450));
 }
 function finish(id:string){
  const choice=pending[id];if(!choice)return;
  clearTimeout(timers.get(id));timers.delete(id);
  const next={...pending};delete next[id];pending=next;
  if([...items,...picked].some(item=>item.id===id))onjudge(id,choice.include);
 }
 function done(){if(!ready||retesting)return;for(const id of Object.keys(pending))finish(id);ondone();}
 onDestroy(()=>{for(const timer of timers.values())clearTimeout(timer);clearTimeout(lookupTimer);lookup?.abort();});
 function find(q:string,delay=150){
  query=q;clearTimeout(lookupTimer);
  lookupTimer=setTimeout(async()=>{lookup?.abort();const controller=new AbortController();lookup=controller;
   try{const items=await search!(q,controller.signal);if(!controller.signal.aborted){found=items;active=0;searchFailed=false;}}catch{if(!controller.signal.aborted)searchFailed=true;}},delay);
 }
 function openPicker(){picking=true;find('',0);}
 function closePicker(){picking=false;query='';found=[];clearTimeout(lookupTimer);lookup?.abort();}
 function pick(note:PickableNote){closePicker();onpick?.(note.id);}
 function keys(e:KeyboardEvent){
  if(e.key==='ArrowDown'){e.preventDefault();active=Math.min(active+1,found.length-1);}
  else if(e.key==='ArrowUp'){e.preventDefault();active=Math.max(active-1,0);}
  else if(e.key==='Enter'&&found[active]){e.preventDefault();pick(found[active]);}
  else if(e.key==='Escape'){e.preventDefault();closePicker();}
 }
 function focus(input:HTMLInputElement){input.focus();}
 function show(dialog:HTMLDialogElement){dialog.showModal();}
</script>
<div class="review">
 {#if showExamples}
 <div class="heading"><span>Include these?</span></div>
 <div class="cards">
 {#each picked as item (item.id)}
  <article class="picked" class:fading={pending[item.id]?.fading}>
   <div class="source"><small>{item.origin} · Added by you</small><button class="title" onclick={()=>opened=item}>{item.title}</button><p>{item.excerpt}</p></div>
   <div class="judgments">
    <button aria-label={`Included: ${item.title}`} title="Included" class="chosen" aria-pressed="true" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11H3V10zM7 10l5-7c2 0 3 1 2 4l-1 3h6a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7"/></svg></button>
    <button aria-label={`Exclude: ${item.title}`} title="Exclude" class:chosen={pending[item.id]?.include===false} aria-pressed={pending[item.id]?.include===false} disabled={!!pending[item.id]||retesting} onclick={()=>judge(item.id,false)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 14V3H3v11zM7 14l5 7c2 0 3-1 2-4l-1-3h6a2 2 0 0 0 2-2l-2-7a2 2 0 0 0-2-2H7"/></svg></button>
   </div>
  </article>
 {/each}
 {#each items.slice(0,3) as item (item.id)}
  <article class:fading={pending[item.id]?.fading}>
   <div class="source"><small>{item.origin}</small><button class="title" onclick={()=>opened=item}>{item.title}</button><p>{item.excerpt}</p></div>
   <div class="judgments">
    <button aria-label={`Include: ${item.title}`} title="Include" class:chosen={pending[item.id]?.include===true} aria-pressed={pending[item.id]?.include===true} disabled={!!pending[item.id]||retesting} onclick={()=>judge(item.id,true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11H3V10zM7 10l5-7c2 0 3 1 2 4l-1 3h6a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7"/></svg></button>
    <button aria-label={`Exclude: ${item.title}`} title="Exclude" class:chosen={pending[item.id]?.include===false} aria-pressed={pending[item.id]?.include===false} disabled={!!pending[item.id]||retesting} onclick={()=>judge(item.id,false)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 14V3H3v11zM7 14l5 7c2 0 3-1 2-4l-1-3h6a2 2 0 0 0 2-2l-2-7a2 2 0 0 0-2-2H7"/></svg></button>
   </div>
  </article>
 {:else}{#if !picked.length}<p class="empty">No more examples.</p>{/if}{/each}
 </div>
 {#if search&&onpick}
  {#if picking}
   <div class="picker">
    <input use:focus type="search" aria-label="Find a note to include" placeholder="Find a note to include" autocomplete="off" value={query} oninput={e=>find(e.currentTarget.value)} onkeydown={keys}/>
    <ul role="listbox" aria-label="Notes">
     {#each found as note,i (note.id)}<li role="option" aria-selected={i===active}><button class:active={i===active} onmouseenter={()=>active=i} onclick={()=>pick(note)}><span>{note.title}</span><small>{note.origin}</small></button></li>
     {:else}<li class="none">{searchFailed?'Search is unavailable.':query.trim()?'No notes match.':'No notes left to add.'}</li>{/each}
    </ul>
    <button class="add-manual" onclick={closePicker}>Close</button>
   </div>
  {:else}<button class="add-manual" disabled={retesting} onclick={openPicker}>Add something manually</button>{/if}
 {/if}
 {/if}
 <div class="review-footer"><p role="status" aria-live="polite">{status}</p><button class="done" disabled={!ready||retesting||Object.keys(pending).length>0} onclick={done}>Done</button></div>
</div>
{#if opened}
 <dialog use:show onclose={()=>opened=null} aria-label={opened.title}><div class="dialog-head"><small>{opened.origin}</small><button onclick={()=>opened=null} aria-label="Close source">×</button></div><h2>{opened.title}</h2><p class="body">{opened.body}</p></dialog>
{/if}
<style>
 .review{display:grid;gap:16px}.heading{display:flex;align-items:center;justify-content:space-between;font:var(--type-body);color:var(--text-strong)}
 button{cursor:pointer;color:var(--text-strong);background:transparent;border:1px solid var(--rule);font:var(--type-meta)}
 .review-footer{display:flex;justify-content:space-between;align-items:center;gap:20px;padding-top:4px}.done:disabled{opacity:.3;cursor:default}
 .done{padding:8px 18px;background:var(--text-strong);color:var(--bg);border-color:var(--text-strong)}
 .cards{display:grid;gap:12px}article{display:flex;align-items:center;gap:24px;padding:20px;border:1px solid var(--rule);background:var(--bg)}
 article{transition:opacity 260ms ease;animation:arrive 180ms ease-out}article.fading{opacity:0;pointer-events:none}
 @keyframes arrive{from{opacity:0}to{opacity:1}}
 .judgments button.chosen,.judgments button.chosen:hover{background:var(--text-strong);color:var(--bg);border-color:var(--text-strong)}
 .judgments button:disabled{cursor:default}.judgments button:disabled:not(.chosen){opacity:.35}
 @media(prefers-reduced-motion:reduce){article{animation:none;transition:none}article.fading{opacity:1}}
 .source{flex:1;min-width:0;display:grid;gap:7px}small{font:var(--type-meta);color:var(--text-muted)}
 .title{text-align:left;padding:0;border:0;font:var(--type-body);line-height:1.4;justify-self:start}.title:hover{text-decoration:underline;text-underline-offset:3px}
 p{margin:0;font:var(--type-meta);line-height:1.6;color:var(--text-note)}
 .judgments{display:flex;gap:8px}.judgments button{width:40px;height:40px;display:grid;place-items:center}.judgments svg{width:19px;height:19px}
 .judgments button:hover{border-color:var(--text-strong);background:var(--well)}button:focus-visible{outline:2px solid var(--text-strong);outline-offset:3px}
 dialog{box-sizing:border-box;width:min(640px,calc(100vw - 32px));max-height:80vh;padding:28px;border:1px solid var(--rule);background:var(--bg);color:var(--text-strong)}dialog::backdrop{background:#0007}.dialog-head{display:flex;justify-content:space-between;align-items:center}.dialog-head button{border:0;font-size:24px;padding:0 6px}h2{font:var(--type-heading);line-height:1.35;margin:22px 0}.body{white-space:pre-wrap;font:var(--type-body);line-height:1.7}.empty{padding:24px 0}
 .add-manual{justify-self:start;background:none;border:0;padding:0;font:var(--type-meta);color:var(--text-muted);text-decoration:underline;text-underline-offset:3px}.add-manual:disabled{opacity:.35;cursor:default}.add-manual:hover:not(:disabled){color:var(--text-strong)}
 .picker{display:grid;gap:10px}.picker input{box-sizing:border-box;width:100%;min-width:0;padding:12px 14px;border:1px solid var(--rule);border-radius:0;background:var(--well);color:var(--text-strong);font:var(--type-body)}.picker input:focus-visible{outline:1px solid var(--text-muted);outline-offset:3px}
 .picker ul{list-style:none;margin:0;padding:0;max-height:280px;overflow-y:auto;border:1px solid var(--rule)}.picker li button{display:flex;justify-content:space-between;align-items:baseline;gap:16px;width:100%;padding:10px 14px;border:0;text-align:left;font:var(--type-body)}.picker li button span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.picker li button small{flex:none}.picker li button.active{background:var(--well)}.picker .none{padding:10px 14px;font:var(--type-meta);color:var(--text-muted)}
 @media(max-width:600px){article{padding:16px;gap:16px;align-items:flex-start}.judgments{flex-direction:column}.picker li button{flex-direction:column;gap:2px}.picker li button span{max-width:100%}}
</style>
