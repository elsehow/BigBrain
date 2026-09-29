<script lang="ts">
 import {onMount} from 'svelte';
 import {vaultFetch} from '../lib/vaultScope';
 let configured=$state(false),loading=$state(true),editing=$state(false),key=$state(''),busy=$state(false),problem=$state('');
 async function request(method='GET',apiKey?:string){const r=await vaultFetch('/api/models/jev',{method,headers:{'Content-Type':'application/json'},body:apiKey===undefined?undefined:JSON.stringify({apiKey})});const data=await r.json();if(!r.ok)throw Error(data.error??'Could not load Jev settings.');configured=data.configured;}
 onMount(()=>{void request().catch(e=>problem=e.message).finally(()=>loading=false)});
 async function save(){busy=true;problem='';try{await request('POST',key);key='';editing=false;}catch(e){problem=(e as Error).message;}finally{busy=false;}}
 async function remove(){busy=true;problem='';try{await request('DELETE');key='';editing=false;}catch(e){problem=(e as Error).message;}finally{busy=false;}}
</script>
<div class="jev">
 <span>Jev <small>Optional</small></span>
 <div class="options">
  <p>Evaluates shared-vault inclusion rules. Uses Quick when no Jev key is set.</p>
  {#if loading}<p role="status">Loading…</p>
  {:else}
   <p class="status">{configured?'Jev configured':'Using Quick'}</p>
   {#if editing}
    <form onsubmit={e=>{e.preventDefault();void save()}}>
     <label>Jev API key<input type="password" autocomplete="new-password" bind:value={key} disabled={busy} spellcheck="false" /></label>
     <small>Validation sends sample text to TypeSafe.</small>
     <div class="actions"><button class="settings-add" disabled={busy||!key.trim()}>{busy?'Checking…':'Save key'}</button><button type="button" class="cancel" disabled={busy} onclick={()=>{editing=false;key='';problem=''}}>Cancel</button></div>
    </form>
   {:else}
    <div class="actions"><button class="settings-add" disabled={busy} onclick={()=>editing=true}>{configured?'Replace key':'Add API key'}</button>{#if configured}<button class="cancel" disabled={busy} onclick={remove}>Remove key and use Quick</button>{/if}</div>
   {/if}
  {/if}
  {#if problem}<p role="alert">{problem}</p>{/if}
 </div>
</div>
<style>
 .jev{display:grid;grid-template-columns:90px minmax(0,1fr);gap:16px;padding:12px 0;border-bottom:1px solid var(--rule);font:var(--type-body)}
 .options,form,label{display:flex;flex-direction:column;gap:var(--sp-2)}
 p{margin:0;color:var(--text-note)}small{font:var(--type-meta);color:var(--text-muted)}.jev>span small{display:block}.status{color:var(--text-strong)}
 input{padding:8px;font:var(--type-body);border:1px solid var(--rule);background:var(--well);color:var(--fg);width:100%;box-sizing:border-box}
 .actions{display:flex;align-items:center;gap:var(--sp-3)}.cancel{background:none;border:0;padding:0;color:var(--text-muted);font:var(--type-meta);text-decoration:underline;cursor:pointer}
 [role=alert]{color:var(--accent-2)}button:disabled{opacity:.5;cursor:default}
 @media(max-width:600px){.jev{grid-template-columns:1fr;gap:8px}}
</style>
