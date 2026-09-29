<script lang="ts">
 import {onMount,onDestroy,untrack} from 'svelte';
 import {vaultFetch} from '../lib/vaultScope';
 import PilotMentionComposer from './PilotMentionComposer.svelte';
 import InclusionRuleReview,{type RuleExample} from './InclusionRuleReview.svelte';
 import {serializeMentions} from '../../../../lib/pilotMentions';
 let {target,value,onsave,oncancel}:{target:{kind:'shared';id:string}|{kind:'integration';name:string;account:string};value:string;onsave:(text:string)=>void;oncancel?:()=>void}=$props();
 type View={id:string;text:string;revision:number;busy:boolean;ready:boolean;remaining:number;overlap:boolean;judged:number;unresolved:number;error?:string;items:RuleExample[];exhausted:boolean};
 let draft=$state(untrack(()=>value)),view=$state<View|null>(null),problem=$state(''),sending=$state(false),editing=$state(false),disposed=false;
 let editTimer:ReturnType<typeof setTimeout>|undefined;
 let generation=0;
 async function request(action:string,body?:unknown){const r=await vaultFetch('/api/inclusion-review/'+action,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error??'Could not evaluate the rule.');return data;}
 async function follow(result:View,g:number){view=result;while(view?.busy&&!disposed&&g===generation){await new Promise(r=>setTimeout(r,700));if(disposed||g!==generation)return;const next=await request('?id='+encodeURIComponent(result.id));if(g===generation)view=next;}}
 async function start(){if(!draft.trim()||sending)return;const g=++generation;sending=true;problem='';try{await follow(await request('start',{target,text:draft}),g);}catch(e){problem=(e as Error).message;}finally{sending=false;}}
 onMount(()=>{if(draft.trim())void start();});
 onDestroy(()=>{disposed=true;generation++;clearTimeout(editTimer);});
 function changed(text:string){if(text===draft)return;draft=text;editing=true;clearTimeout(editTimer);editTimer=setTimeout(()=>void update(),650);}
 async function update(){if(disposed)return;if(sending){editTimer=setTimeout(()=>void update(),200);return;}if(!draft.trim()){editing=false;return;}if(!view){editing=false;await start();return;}
  const text=draft,g=++generation;sending=true;problem='';try{await follow(await request('edit',{id:view.id,text,revision:view.revision}),g);}catch(e){problem=(e as Error).message;}finally{sending=false;if(text===draft)editing=false;else editTimer=setTimeout(()=>void update(),100);}
 }
 async function judge(source:string,include:boolean){if(!view||sending||editing)return;sending=true;problem='';const g=++generation;try{await follow(await request('rate',{id:view.id,source,include,revision:view.revision}),g);}catch(e){problem=(e as Error).message;}finally{sending=false;}}
 async function retry(){if(!view)return void start();sending=true;problem='';const g=++generation;try{await follow(await request('retry',{id:view.id}),g);}catch(e){problem=(e as Error).message;}finally{sending=false;}}
 async function done(){if(!view||sending||editing)return;sending=true;problem='';try{await request('finish',{id:view.id});onsave(view.text);}catch(e){problem=(e as Error).message;}finally{sending=false;}}
 async function search(q:string,signal:AbortSignal){const r=await vaultFetch('/api/inclusion-review/entities?q='+encodeURIComponent(q),{signal});if(!r.ok)throw Error('Entity search unavailable');return(await r.json()).items;}
 const status=$derived(editing||view?.busy?'Retesting against your judgments…':view?.ready?'Ready when you are.':view?.overlap?'The rule does not separate your ratings. Refine it to continue.':view?.exhausted?'No more examples available. Sync more sources to continue.':`Rate ${view?.remaining??4} more ${(view?.remaining??4)===1?'example':'examples'} to refine the inclusion rule.`);
</script>
<div class="editor" role="group" aria-label="Inclusion rule review">
 <div class="rule-input"><PilotMentionComposer ariaLabel="Inclusion rule" value={draft} recents={[]} currentId="inclusion-rule" {search} onchange={parts=>changed(serializeMentions(parts))} onsend={()=>{}} placeholder="Describe what belongs here. Use @ to mention a topic." /></div>
 {#if view}<InclusionRuleReview items={view.items} onjudge={judge} ondone={done} ready={view.ready&&!editing&&!sending&&!!draft.trim()} retesting={view.busy||editing||sending} {status}/>
 {:else if sending}<p role="status">Finding examples…</p>
 {:else}<button class="settings-add" disabled={!draft.trim()} onclick={start}>Try rule</button>{/if}
 {#if problem||view?.error}<p role="alert">{problem||view?.error}</p><button class="settings-add" disabled={sending} onclick={retry}>Retry</button>{/if}
 {#if view?.exhausted&&!problem&&!view.error&&!view.ready}<button class="settings-add" disabled={sending} onclick={retry}>Refresh examples</button>{/if}
 {#if view?.unresolved}<small>{view.unresolved} sources could not be evaluated; they haven’t been treated as exclusions.</small>{/if}
 {#if oncancel}<button class="cancel" onclick={oncancel}>Cancel</button>{/if}
</div>
<style>
 .editor{display:grid;gap:20px}.rule-input{border:1px solid var(--rule);background:var(--well)}.rule-input:focus-within{border-color:var(--text-muted)}.rule-input :global(.mention-composer::before){display:none}.rule-input :global(.editor){padding:20px;min-height:104px;font:var(--type-body);line-height:1.6}p,small{margin:0;font:var(--type-meta);color:var(--text-muted)}[role=alert]{color:var(--accent-2)}.cancel{justify-self:start;background:none;border:0;padding:0;font:var(--type-meta);color:var(--text-muted);cursor:pointer;text-decoration:underline}@media(max-width:600px){.rule-input :global(.editor){padding:16px}}
</style>
