<script lang="ts">
 import {onDestroy} from "svelte";
 import SettingsPage from '../components/SettingsPage.svelte';
 import InclusionRuleReview,{type RuleExample} from '../components/InclusionRuleReview.svelte';
 import PilotMentionComposer from '../components/PilotMentionComposer.svelte';
 import {serializeMentions} from '../../../../lib/pilotMentions';
 let context=$state('vault'),theme=$state('dusk'),saved=$state(false),session=$state(0);
 const initial='Sources about [[projection/entities/ent_example.md|Atlas]]. Audience: people building or marketing Atlas.';
 let rule=$state(initial),retesting=$state(false);
 let retestTimer:ReturnType<typeof setTimeout>|undefined;
 onDestroy(()=>clearTimeout(retestTimer));
 function changeRule(text:string){
  if(text===rule)return;
  rule=text;retesting=true;clearTimeout(retestTimer);
  // Simulated evaluation latency; this workbench does not call a model.
  retestTimer=setTimeout(()=>retesting=false,900);
 }
 const examples:RuleExample[]=[
 {id:'1',title:'A simpler first five minutes',origin:'Slack · #atlas-product · Today',excerpt:'New users reach an empty workspace before they understand what Atlas does. What if the first screen let them try a sample project?',body:'New users reach an empty workspace before they understand what Atlas does. What if the first screen let them try a sample project?\n\nMara suggested a project with three sources and one answered question. We could compare that with the current setup flow in next week’s sessions. No account should be needed to explore the sample.'},
 {id:'2',title:'What I want work to feel like',origin:'Personal note · Yesterday',excerpt:'Atlas came up over dinner. I keep thinking about whether I want to build a company or just make room for a more creative life.',body:'Atlas came up over dinner. I keep thinking about whether I want to build a company or just make room for a more creative life.\n\nI miss having afternoons with no plan. The project is exciting, but sometimes I make it responsible for answering questions it cannot answer. This is more about how I want to spend my days than what we should build.'},
 {id:'3',title:'Finding the right words for Atlas',origin:'Document · Sep 28',excerpt:'“A place for everything you know” sounds broad. The useful promise may be narrower: find the evidence behind an answer, without remembering where you saved it.',body:'“A place for everything you know” sounds broad. The useful promise may be narrower: find the evidence behind an answer, without remembering where you saved it.\n\nTry two landing-page openings. One starts with collecting research; the other starts with a question. Ask readers what they expect the product to do before showing the demo.'},
 {id:'4',title:'Search that remembers the source',origin:'Article · Sep 27',excerpt:'A search result becomes more useful when it shows where a claim came from and lets readers inspect the original passage.',body:'A search result becomes more useful when it shows where a claim came from and lets readers inspect the original passage.\n\nThis article compares source previews in several research tools. It does not mention Atlas, but its design examples may inform our evidence viewer.'},
 {id:'5',title:'Weekend walk, and a small idea',origin:'Personal note · Sep 26',excerpt:'We talked about the garden, the trip, and an Atlas feature I couldn’t stop thinking about. Mostly I was glad to be away from a screen.',body:'We talked about the garden, the trip, and an Atlas feature I couldn’t stop thinking about. Mostly I was glad to be away from a screen.\n\nThe feature was a half-formed thought about folders. I didn’t write down the details. The important part of the day was seeing everyone again.'},
 {id:'6',title:'Import failures should be visible',origin:'Slack · #atlas-engineering · Sep 25',excerpt:'If a document fails during import, Atlas should retain its place in the queue and explain what happened. Silent retries make the list look complete when it isn’t.',body:'If a document fails during import, Atlas should retain its place in the queue and explain what happened. Silent retries make the list look complete when it isn’t.\n\nProposal: show failed items inline, with Retry and Remove actions. Preserve the original error for diagnostics without exposing it as the primary user-facing message.'},
 {id:'7',title:'A name collision',origin:'Email · Sep 24',excerpt:'The customer thought Atlas was the mapping service they already use. We should test whether the product description clears this up.',body:'The customer thought Atlas was the mapping service they already use. We should test whether the product description clears this up.\n\nI attached notes from the interview. Two participants expected maps; the other three understood it as a research tool after reading the subtitle.'},
 {id:'8',title:'Reading list for the train',origin:'Personal note · Sep 23',excerpt:'A novel, an essay about walking, and the Atlas documentation I promised to skim. Probably too much for a two-hour ride.',body:'A novel, an essay about walking, and the Atlas documentation I promised to skim. Probably too much for a two-hour ride.\n\nRemember to download everything before leaving.'},
 {id:'9',title:'Sharing without losing attribution',origin:'Document · Sep 22',excerpt:'When two people contribute the same source to Atlas, preserve both contributions. Removing one should not erase the other person’s copy.',body:'When two people contribute the same source to Atlas, preserve both contributions. Removing one should not erase the other person’s copy.\n\nWe need a source identity separate from the contribution identity. The viewer can show one item while its history records who shared it.'}
 ];
 let visible=$state(examples.slice(0,3)),next=$state(3),judgments=$state<Record<string,boolean>>({});
 const ready=$derived(!!rule.trim()&&Object.values(judgments).includes(true)&&Object.values(judgments).includes(false));
 const reviewStatus=$derived(retesting?'Retesting against your judgments…':!rule.trim()?'Write an inclusion rule to continue.':ready?'Ready when you are.':'Include and exclude examples to refine the rule.');
 function reset(){clearTimeout(retestTimer);retesting=false;session++;visible=examples.slice(0,3);next=3;judgments={};saved=false;}
 function judge(id:string,include:boolean){judgments={...judgments,[id]:include};const replacement=examples[next++];visible=visible.flatMap(item=>item.id===id?(replacement?[replacement]:[]):[item]);}
 $effect(()=>{document.documentElement.dataset.theme=theme;});
 const mention={id:'projection/entities/ent_example.md',title:'Atlas',tag:'ENTITY' as const};
</script>
<div class="workbench"><span>Inclusion rule · interaction study</span><div><select aria-label="Context" bind:value={context} onchange={reset}><option value="vault">Shared vault</option><option value="integration">Integration</option></select><select aria-label="Theme" bind:value={theme}><option value="dusk">Dusk</option><option value="default">Light</option><option value="web">Web blue</option></select><button onclick={reset}>Reset</button></div></div>
<main><SettingsPage active={context==='vault'?'vaultSettings':'integrations'} title={context==='vault'?'ATLAS':'SLACK'} extraSection={{label:'SHARED VAULTS',active:context==='vault',items:[{label:'Atlas',selected:context==='vault',onselect:()=>{context='vault';reset()}}]}}>
 <section class="content"><div class="intro"><h2>Inclusion rule</h2><p>{context==='vault'?'Personal → Atlas':'Slack → Personal'}</p></div>
 {#if saved}<div class="saved"><p>{rule.replace(/\[\[[^|]+\|([^\]]+)\]\]/g,'@$1')}</p><div><small>Saved with {Object.keys(judgments).length} examples</small><button onclick={()=>saved=false}>Edit rule</button></div></div>
 {:else}<div class="rule-editor"><PilotMentionComposer ariaLabel="Inclusion rule" value={rule} currentId="inclusion-study" recents={[]} search={async(q)=>'atlas'.includes(q.toLowerCase())?[mention]:[]} onchange={parts=>changeRule(serializeMentions(parts))} onsend={()=>{}} placeholder="Describe what belongs here. Use @ to mention a topic." /></div>
 {#key session}<InclusionRuleReview items={visible} onjudge={judge} ondone={()=>saved=true} {ready} {retesting} status={reviewStatus}/>{/key}{/if}
 </section>
</SettingsPage></main>
<footer>Component workbench · Fabricated examples · Feedback stays in this page · Retesting is simulated; one include + one exclude demonstrates readiness · Same review component for vaults and integrations · Based on 52ca198</footer>
<style>
 :global(body){margin:0;background:var(--bg);color:var(--text)}.workbench{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 28px;border-bottom:1px solid var(--rule);font:var(--type-meta);color:var(--text-muted)}.workbench>div{display:flex;gap:12px}button,select{font:var(--type-meta);padding:6px 10px;border:1px solid var(--rule);background:var(--bg);color:var(--text-strong);cursor:pointer}main{padding:30px 0}.content{display:grid;gap:24px}.intro{display:flex;justify-content:space-between;align-items:baseline;gap:16px}h2{font:var(--type-heading);margin:0;color:var(--text-strong)}.intro p,small{font:var(--type-meta);color:var(--text-muted);margin:0}.saved{display:grid;gap:24px}.saved p{font:var(--type-body);line-height:1.6;margin:0}.saved>div{display:flex;justify-content:space-between;align-items:center}footer{padding:18px 28px;font:var(--type-meta);color:var(--text-faint);border-top:1px solid var(--rule)}@media(max-width:700px){.workbench{flex-wrap:wrap}.intro{align-items:flex-start;flex-direction:column;gap:8px}}
 .rule-editor{border:1px solid var(--rule);background:var(--well)}
 .rule-editor:focus-within{border-color:var(--text-muted)}
 .rule-editor :global(.mention-composer::before){display:none}
 .rule-editor :global(.editor){padding:20px;min-height:104px;font:var(--type-body);line-height:1.6}
 @media(max-width:600px){.rule-editor :global(.editor){padding:16px}}
</style>
