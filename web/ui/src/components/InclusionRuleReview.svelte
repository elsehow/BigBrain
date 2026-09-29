<script lang="ts">
 export interface RuleExample {id:string;title:string;origin:string;excerpt:string;body:string}
 let {items,onjudge,ondone}:{items:RuleExample[];onjudge:(id:string,include:boolean)=>void;ondone:()=>void}=$props();
 let opened=$state<RuleExample|null>(null);
 function show(dialog:HTMLDialogElement){dialog.showModal();}
</script>
<div class="review">
 <div class="heading"><span>Include these?</span><button class="done" onclick={ondone}>Done</button></div>
 <div class="cards">
 {#each items.slice(0,3) as item (item.id)}
  <article>
   <div class="source"><small>{item.origin}</small><button class="title" onclick={()=>opened=item}>{item.title}</button><p>{item.excerpt}</p></div>
   <div class="judgments">
    <button aria-label={`Include: ${item.title}`} title="Include" onclick={()=>onjudge(item.id,true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11H3V10zM7 10l5-7c2 0 3 1 2 4l-1 3h6a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 2H7"/></svg></button>
    <button aria-label={`Exclude: ${item.title}`} title="Exclude" onclick={()=>onjudge(item.id,false)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 14V3H3v11zM7 14l5 7c2 0 3-1 2-4l-1-3h6a2 2 0 0 0 2-2l-2-7a2 2 0 0 0-2-2H7"/></svg></button>
   </div>
  </article>
 {:else}<p class="empty">No more examples. You’re ready to save.</p>{/each}
 </div>
</div>
{#if opened}
 <dialog use:show onclose={()=>opened=null} aria-label={opened.title}><div class="dialog-head"><small>{opened.origin}</small><button onclick={()=>opened=null} aria-label="Close source">×</button></div><h2>{opened.title}</h2><p class="body">{opened.body}</p></dialog>
{/if}
<style>
 .review{display:grid;gap:16px}.heading{display:flex;align-items:center;justify-content:space-between;font:var(--type-body);color:var(--text-strong)}
 button{cursor:pointer;color:var(--text-strong);background:transparent;border:1px solid var(--rule);font:var(--type-meta)}
 .done{padding:8px 18px;background:var(--text-strong);color:var(--bg);border-color:var(--text-strong)}
 .cards{display:grid;gap:12px}article{display:flex;align-items:center;gap:24px;padding:20px 22px;border:1px solid var(--rule);background:var(--bg)}
 .source{flex:1;min-width:0;display:grid;gap:7px}small{font:var(--type-meta);color:var(--text-muted)}
 .title{text-align:left;padding:0;border:0;font:var(--type-body);line-height:1.4;justify-self:start}.title:hover{text-decoration:underline;text-underline-offset:3px}
 p{margin:0;font:var(--type-meta);line-height:1.6;color:var(--text-note)}
 .judgments{display:flex;gap:8px}.judgments button{width:40px;height:40px;display:grid;place-items:center}.judgments svg{width:19px;height:19px}
 .judgments button:hover{border-color:var(--text-strong);background:var(--well)}button:focus-visible{outline:2px solid var(--text-strong);outline-offset:3px}
 dialog{box-sizing:border-box;width:min(640px,calc(100vw - 32px));max-height:80vh;padding:28px;border:1px solid var(--rule);background:var(--bg);color:var(--text-strong)}dialog::backdrop{background:#0007}.dialog-head{display:flex;justify-content:space-between;align-items:center}.dialog-head button{border:0;font-size:24px;padding:0 6px}h2{font:var(--type-heading);line-height:1.35;margin:22px 0}.body{white-space:pre-wrap;font:var(--type-body);line-height:1.7}.empty{padding:24px 0}
 @media(max-width:600px){article{padding:16px;gap:16px;align-items:flex-start}.judgments{flex-direction:column}}
</style>
