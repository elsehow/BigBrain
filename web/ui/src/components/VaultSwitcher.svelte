<script lang="ts">
 import {onMount} from 'svelte';
 import {selectedVaults,switchVaults} from '../lib/vaultScope';
 let connections=$state<Array<{id:string;name:string}>>([]),error=$state('');
 onMount(async()=>{try{const r=await fetch('/api/shared-connections');if(!r.ok)throw Error();connections=(await r.json()).connections;}catch{error='Could not load vaults.';}});
 function toggle(id:string){switchVaults(selectedVaults.includes(id)?selectedVaults.filter(v=>v!==id):[...selectedVaults,id]);}
</script>
<nav aria-label="Vaults">
 <button aria-pressed={selectedVaults.includes('personal')} onclick={()=>toggle('personal')}>Personal</button>
 {#each connections as c}<button aria-pressed={selectedVaults.includes(c.id)} onclick={()=>toggle(c.id)}>{c.name}</button>{/each}
 {#if error}<p role="alert">{error}</p>{/if}
</nav>
<style>
 nav{display:flex;flex-wrap:wrap;gap:4px 14px;padding:10px 16px 8px;margin-top:8px;flex:none}
 button{padding:3px 0;border:0;background:none;font:var(--type-meta);color:var(--text-muted);cursor:pointer}
 button[aria-pressed=true]{color:var(--text-strong);text-decoration:underline;text-underline-offset:4px}
 button:hover,button:focus-visible{color:var(--text-strong)}
 p{width:100%;font:var(--type-meta);color:var(--text-muted)}
</style>
