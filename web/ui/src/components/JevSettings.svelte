<script lang="ts">
 import {onMount} from 'svelte';
 import {vaultFetch} from '../lib/vaultScope';
 let configured=$state(false),loading=$state(true),editing=$state(false),key=$state(''),busy=$state(false),problem=$state('');
 async function request(method='GET',apiKey?:string){const r=await vaultFetch('/api/models/jev',{method,headers:{'Content-Type':'application/json'},body:apiKey===undefined?undefined:JSON.stringify({apiKey})});const data=await r.json();if(!r.ok)throw Error(data.error??'Could not load Jev settings.');configured=data.configured;}
 onMount(()=>{void request().catch(e=>problem=e.message).finally(()=>loading=false)});
 async function save(){busy=true;problem='';try{await request('POST',key);key='';editing=false;}catch(e){problem=(e as Error).message;}finally{busy=false;}}
 async function remove(){busy=true;problem='';try{await request('DELETE');key='';editing=false;}catch(e){problem=(e as Error).message;}finally{busy=false;}}
</script>
<div class="jev" role="group" aria-label="Jev">
 <span class="name">Jev</span>
 <div class="options">
  {#if loading}<span class="status" role="status">Loading…</span>
  {:else if editing}
   <form onsubmit={e=>{e.preventDefault();void save()}}>
    <label for="jev-key">API key</label>
    <div class="entry"><input id="jev-key" aria-label="Jev API key" type="password" autocomplete="new-password" bind:value={key} disabled={busy} spellcheck="false" /><button disabled={busy||!key.trim()}>{busy?'Checking…':'Save key'}</button><button type="button" disabled={busy} onclick={()=>{editing=false;key='';problem=''}}>Cancel</button></div>
    <small>Validated with sample text sent to TypeSafe.</small>
   </form>
  {:else}
   <div class="controls"><span class="status">{configured?'Connected':'Using Quick'}</span><div class="actions"><button disabled={busy} onclick={()=>editing=true}>{configured?'Replace key':'Add API key'}</button>{#if configured}<button disabled={busy} aria-label="Remove key and use Quick" onclick={remove}>Remove</button>{/if}</div></div>
  {/if}
  <p class="hint">Optional inclusion-rule evaluator. Without a key, uses Quick.</p>
  {#if problem}<p role="alert">{problem}</p>{/if}
 </div>
</div>
<style>
 .jev{display:grid;grid-template-columns:90px minmax(0,1fr);gap:16px;padding:16px 0;border-bottom:1px solid var(--rule);font:var(--type-body)}
 .name{padding-top:6px;color:var(--text-strong)}
 .options,form{display:flex;flex-direction:column;gap:var(--sp-2)}
 .controls,.actions,.entry{display:flex;align-items:center;gap:var(--sp-2)}
 .controls{justify-content:space-between;flex-wrap:wrap;gap:var(--sp-3)}
 .status,label{font:var(--type-meta);color:var(--text-note)}
 p{margin:0}small,.hint{font:var(--type-meta);color:var(--text-muted)}
 input{min-width:0;flex:1;padding:7px 9px;font:var(--type-body);border:1px solid var(--rule);background:var(--well);color:var(--fg);box-sizing:border-box}
 button{padding:6px 10px;border:1px solid var(--rule);background:transparent;color:var(--text-strong);font:var(--type-meta);white-space:nowrap;cursor:pointer}
 button:hover:not(:disabled){background:var(--well);border-color:var(--text-muted)}
 button:focus-visible,input:focus-visible{outline:2px solid var(--text-strong);outline-offset:2px}
 [role=alert]{font:var(--type-meta);color:var(--accent-2)}button:disabled{opacity:.5;cursor:default}
 @media(max-width:600px){.jev{grid-template-columns:1fr;gap:8px}.name{padding:0}.entry{flex-wrap:wrap}.entry input{flex-basis:100%}}
</style>
