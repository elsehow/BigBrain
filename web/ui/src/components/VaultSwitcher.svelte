<script lang="ts">
 import {onMount} from 'svelte';
 import {selectedWorkspace,personalOnly,switchWorkspace} from '../lib/vaultScope';
 let connections=$state<Array<{id:string;name:string}>>([]),error=$state('');
 onMount(async()=>{try{const r=await fetch('/api/shared-connections');if(!r.ok)throw Error();connections=(await r.json()).connections;}catch{error='Could not load vaults.';}});
</script>
<nav aria-label="Vaults">
 <h2>Vaults</h2>
 <button aria-current={!selectedWorkspace&&!personalOnly?'true':undefined} onclick={()=>switchWorkspace(null)}>All vaults</button>
 <button aria-current={personalOnly?'true':undefined} onclick={()=>switchWorkspace('personal')}>Personal</button>
 {#each connections as c}<button aria-current={selectedWorkspace===c.id?'true':undefined} onclick={()=>switchWorkspace(c.id)}>{c.name}</button>{/each}
 {#if error}<p role="alert">{error}</p>{/if}
</nav>
<style>
 nav{border-top:1px solid var(--rule);padding:16px 0 8px;margin-top:12px;flex:none}
 h2{margin:0 16px 8px;font:var(--type-meta);letter-spacing:.12em;text-transform:uppercase;color:var(--text-muted)}
 button{display:block;width:100%;padding:9px 16px;border:0;background:none;text-align:left;font:500 15px/1.4 var(--font-app);color:var(--text-muted);cursor:pointer}
 button[aria-current=true]{color:var(--text-strong);text-decoration:underline;text-underline-offset:4px}
 button:hover,button:focus-visible{background:var(--rule);color:var(--text-strong)}
 p{padding:0 16px;font:var(--type-meta);color:var(--text-muted)}
</style>
