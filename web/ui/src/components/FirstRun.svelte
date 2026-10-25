<script lang="ts">
  import { vaultFetch as fetch } from "../lib/vaultScope";
  import { connectSharedInvite } from "../lib/sharedSettings.svelte";

  import { onMount, tick, untrack } from 'svelte';
  import '../lib/settingsLists.css';
  import VaultPicker from './VaultPicker.svelte';
  import SubscriptionConnect from './SubscriptionConnect.svelte';
  import ClientChecklist from './ClientChecklist.svelte';
  import IntegrationLibrary from './IntegrationLibrary.svelte';
  import SetupThemes from './SetupThemes.svelte';
  import logo from '../assets/logo.svg';
  import { vaultSetupDone, type SetupState } from '../lib/setup';
  import { app } from '../lib/store.svelte';
  let {setup,onPick,onConnect,onName,telemetryPending=false,onConsent}: {
    setup:SetupState;onPick?:(path:string)=>Promise<void>|void;onConnect?:()=>Promise<void>|void;
    onName?:(name:string,email?:string)=>Promise<void>|void;telemetryPending?:boolean;onConsent?:(enabled:boolean)=>Promise<void>;
  }=$props();
  const steps=['Vault','Providers','Clients','Integrations'];
  const phases=['vault','providers','clients','integrations','analytics'] as const;
  function initial(){const i=phases.indexOf(setup.onboarding as typeof phases[number]);return i>=0?i:setup.vault&&setup.identity?1:0;}
  let step=$state(untrack(initial)), name=$state(''),email=$state(''),needsEmail=$state(false);
  let saving=$state(false),moving=$state(false),clientBusy=$state(false),problem=$state('');
  let panel=$state<HTMLDivElement>(),heading=$state<HTMLHeadingElement>();
  // A member joining someone's shared vault finishes setup inside it.
  let invite=$state(''),joining=$state(false),joined=$state<{id:string;name:string}|null>(null);
  async function join(e:SubmitEvent){
    e.preventDefault();if(joining)return;
    joining=true;problem='';
    try{joined=await connectSharedInvite(invite);invite='';}catch(error){problem=error instanceof Error?error.message:'Could not connect.';}finally{joining=false;}
  }
  // a joined vault is already in the field: the engine reads every connected vault together
  const land=()=>{app.rev++;};
  const providerReady=$derived(!!setup.chatgpt?.connected||!!setup.anthropic?.connected);
  const privacy=$derived(step===4);
  const nextReady=$derived(step===0?!!setup.vault&&!!(setup.identity||name.trim()):step===1?providerReady:true);
  const canVisit=(index:number)=>!saving&&!moving&&!clientBusy&&(index===0||!!setup.vault&&!!setup.identity&&(index===1||providerReady));
  async function progress(phase:string){
    const r=await fetch('/api/setup/progress',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({step:phase})});
    const value=await r.json();if(!r.ok)throw Error(value.error||'Could not save setup.');setup=value;
  }
  async function begin(){
    if(!setup.vault||setup.onboarding||vaultSetupDone(setup))return;
    saving=true;problem='';try{await progress(phases[step]);}catch(e){problem=e instanceof Error?e.message:'Could not start setup.';}finally{saving=false;}
  }
  onMount(()=>{void begin();});
  async function go(next:number){
    if(saving||moving||next===step)return;
    saving=true;problem='';
    try{
      if(step===0&&next>0&&!setup.identity){
        if(!onName||!name.trim())throw Error('Enter your name.');
        await onName(name.trim(),email.trim()||undefined);await tick();
      }
      const finish=next===4&&!telemetryPending;
      await progress(finish?'complete':phases[next]);
      if(finish){land();return;}
      moving=true;
      const direction=next>step?1:-1,motion=!matchMedia('(prefers-reduced-motion: reduce)').matches;
      const leaving=motion?panel?.animate([{transform:'translateX(0)',opacity:1},{transform:`translateX(${-direction*24}px)`,opacity:0}],{duration:120,easing:'ease-in',fill:'forwards'}):undefined;
      if(leaving)await leaving.finished;
      step=next;await tick();leaving?.cancel();
      const entering=motion?panel?.animate([{transform:`translateX(${direction*24}px)`,opacity:0},{transform:'translateX(0)',opacity:1}],{duration:180,easing:'ease-out'}):undefined;
      if(entering)await entering.finished;
    }catch(e){problem=e instanceof Error?e.message:'Could not save setup.';if(problem.startsWith('no email'))needsEmail=true;}
    finally{moving=false;saving=false;await tick();heading?.focus();}
  }
  async function consent(enabled?:boolean){
    if(saving)return;
    saving=true;problem='';
    try{
      if(enabled!==undefined){if(!onConsent)throw Error('Sharing preferences unavailable.');await onConsent(enabled);}
      await progress('complete');land();
    }catch{problem='Could not finish setup. Please try again.';}finally{saving=false;}
  }
</script>
<div class="wizard" role="dialog" aria-label="Set up BigBrain">
  <div class="themes"><SetupThemes /></div>
  <main>
    <div class="brand"><img src={logo} alt="" width="36" height="36"/><span>BigBrain</span></div>
    {#if !privacy}<nav aria-label="Setup steps">{#each steps as title,index}<button class:current={step===index} class:done={step>index} aria-current={step===index?'step':undefined} disabled={!canVisit(index)} onclick={()=>go(index)}><span class="number">{step>index?'✓':index+1}</span><span>{title}</span></button>{/each}</nav>{/if}
    <div class="step-frame"><div class="step-content" bind:this={panel} inert={moving}>
    {#if privacy}
      <header><div class="eyebrow">Step 5 of 5 · Optional</div><h1 bind:this={heading} tabindex="-1">Help improve BigBrain</h1></header>
      <p class="intro">Share basic usage and performance measurements with BigBrain through PostHog. You can change this anytime in Settings → Diagnostics.</p>
      <p class="privacy">Reports are linked by a random installation ID, created when you enable analytics.</p>
      <details><summary>What's collected</summary>
        <p>Engine version, operating system and architecture; CPU, memory and timer-delay summaries; foreground and gardening state; engine running time; counts, timings and failures for search, graph, note and Pilot requests; and counts of notes opened and Pilot inputs accepted. Reports include event IDs and timestamps.</p>
        <p>The installation ID persists across restarts. Turning analytics off removes it and clears unsent reports. Enabling again creates a new ID. Previously sent reports remain with PostHog.</p>
      </details>
      <p class="privacy"><a href="https://bigbrain.cool/privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a></p>
      {#if telemetryPending}
        <footer class="consent-actions"><button disabled={saving} onclick={()=>consent(false)}>No thanks</button><button class="opt-in" disabled={saving} onclick={()=>consent(true)}>Opt-in!</button></footer>
      {:else}
        <p class="privacy">You can finish setup and manage analytics in Settings → Diagnostics.</p>
        <footer><button disabled={saving} onclick={()=>consent()}>Finish →</button></footer>
      {/if}
    {:else}
      <header><div class="eyebrow">Step {step+1} of {telemetryPending?5:4}</div><h1 bind:this={heading} tabindex="-1">{['Where should your vault live?','Connect providers','Connect clients','Connect integrations'][step]}</h1><p class="intro">{['Pick an empty folder, or one that already holds a BigBrain vault.','BigBrain will use your subscriptions to maintain your vault.','Let your agents to access BigBrain. (This is where the magic happens!).','Integrations help BigBrain pull the stuff that matters to you.'][step]}</p></header>
      <div class="body settings">
        {#if step===0}
          {#if setup.vault}<div class="chosen"><span>{setup.vault.path}</span><span class="status">Selected</span></div>{/if}
          <VaultPicker suggested={setup.vault?.path??setup.suggested} pick={setup.pick} {onPick}/>
          {#if setup.vault&&!setup.identity}<label class="identity">Your name<input bind:value={name} autocomplete="name" disabled={saving} placeholder="Your name"/></label>{#if needsEmail}<label class="identity">Your email<input bind:value={email} type="email" autocomplete="email" disabled={saving}/></label>{/if}{/if}
        {:else if step===1}
          <div class="providers" inert={saving}>
            <section aria-label="Claude provider"><SubscriptionConnect provider="anthropic" {setup} compact onChange={s=>setup=s}/></section>
            <section aria-label="ChatGPT provider"><SubscriptionConnect provider="chatgpt" {setup} compact onChange={s=>setup=s}/></section>
          </div>
        {:else if step===2}<ClientChecklist onBusy={value=>clientBusy=value} />
        {:else}<IntegrationLibrary />
          <section class="shared-invite" aria-label="Shared vault">
            <h2>Shared vault</h2>
            {#if joined}<div class="chosen"><span>{joined.name}</span><span class="status">Connected</span></div>
            {:else}<p>Joining someone's shared vault? Paste the invite link they sent you.</p>
              <form onsubmit={join}><label>Invite link<input type="url" required bind:value={invite} disabled={joining} placeholder="https://vault.example.org/invite#…" autocomplete="off"/></label><button disabled={joining||!invite.trim()}>{joining?'Connecting…':'Connect'}</button></form>{/if}
          </section>{/if}
      </div>
      <footer>{#if step>0}<button class="back" disabled={saving||moving||clientBusy} onclick={()=>go(step-1)}>← Back</button>{/if}<div class="forward">{#if step>=2}<button class="skip" disabled={saving||moving||clientBusy} onclick={()=>go(step+1)}>Skip</button>{/if}<button class="primary" disabled={!nextReady||saving||moving||clientBusy} onclick={()=>go(step+1)}>{saving?'Saving…':step===3&&!telemetryPending?'Finish →':'Next →'}</button></div></footer>
    {/if}
    {#if problem}<p role="alert">{problem}</p>{/if}
    </div></div>
  </main>
</div>
<style>
.wizard{flex:1;min-height:0;overflow:auto;background:var(--bg);color:var(--text-strong)}.themes{position:absolute;top:16px;right:16px;z-index:2}main{width:100%;max-width:836px;margin:70px auto 80px;padding:0 28px}.brand{display:flex;align-items:center;gap:12px;font-size:19px;font-weight:600;margin-bottom:36px}.step-frame{overflow:clip;padding:4px;margin:-4px}.step-content{width:100%}
nav{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:48px}nav button{display:flex;gap:10px;align-items:center;text-align:left;padding:0 0 12px;border:0;border-bottom:2px solid var(--rule);border-radius:0;color:var(--text-muted);font-size:14px}nav button.current{color:var(--text-strong);border-color:var(--text-strong)}nav button:disabled{opacity:1;cursor:default}nav button.done{color:var(--text-strong)}.number{display:grid;place-items:center;width:24px;height:24px;border:1px solid var(--rule);border-radius:50%;font-size:12px;flex:none}.current .number,.done .number{background:var(--text-strong);color:var(--bg);border-color:var(--text-strong)}
.eyebrow{font:var(--type-meta);font-size:11px;text-transform:uppercase;letter-spacing:.18em;color:var(--text-muted);margin-bottom:12px}h1{font-size:38px;font-weight:550;line-height:1.15;letter-spacing:-.025em;margin:0 0 18px}h1:focus{outline:0}.intro{font-size:17px;line-height:1.6;color:var(--text-muted);margin:0}.body{margin-top:36px;min-height:200px}.providers{display:grid;gap:24px}.providers section{padding-bottom:24px;border-bottom:1px solid var(--rule)}
button{font:var(--type-body);padding:10px 16px;border:1px solid var(--rule);border-radius:0;background:transparent;color:var(--text-strong);cursor:pointer;line-height:1.4;white-space:nowrap}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--activity);outline-offset:3px}.primary{background:var(--text-strong);color:var(--bg);border-color:var(--text-strong)}footer{display:flex;align-items:center;gap:16px;border-top:1px solid var(--rule);margin-top:40px;padding-top:24px}.forward{display:flex;gap:12px;margin-left:auto}.back,.skip{border-color:transparent;color:var(--text-muted)}.chosen{display:flex;justify-content:space-between;gap:20px;border:1px solid var(--rule);border-radius:0;padding:16px;margin-bottom:12px;font-size:14px;overflow-wrap:anywhere}.status{font:var(--type-meta);color:var(--text-muted)}.identity{display:grid;gap:12px;font:var(--type-body);margin-top:20px}.identity input{padding:12px;font:inherit;background:var(--well);color:var(--text);border:1px solid var(--rule)}.privacy{font:var(--type-body);line-height:1.6;margin-top:24px}[role=alert]{font:var(--type-meta);color:var(--err);margin-top:16px}
.consent-actions{flex-wrap:wrap}.consent-actions button:is(:hover,:focus-visible){background:var(--well);border-color:var(--dash)}details{margin-top:24px;font:var(--type-body);line-height:1.6}summary{cursor:pointer}details p{color:var(--text-muted)}a{color:inherit;text-underline-offset:3px}
.consent-actions .opt-in{background:var(--text-strong);color:var(--bg);border-color:var(--text-strong);transition:background-color 120ms ease,box-shadow 120ms ease}
.consent-actions .opt-in:is(:hover,:focus-visible):not(:disabled){background:color-mix(in srgb,var(--text-strong) 93%,var(--bg));border-color:var(--text-strong);box-shadow:3px 3px 0 color-mix(in srgb,var(--text-strong) 30%,transparent)}
.consent-actions .opt-in:active:not(:disabled){background:var(--text-strong);box-shadow:inset 0 0 0 2px var(--bg)}
.shared-invite{display:grid;gap:14px;margin-top:30px}.shared-invite h2{font:var(--type-body);font-weight:500;margin:0}.shared-invite p{font:var(--type-meta);color:var(--text-muted);line-height:1.5;margin:0}.shared-invite form{display:flex;align-items:flex-end;gap:12px}.shared-invite label{flex:1;display:grid;gap:8px;font:var(--type-meta);color:var(--text-muted)}.shared-invite form button{padding:12px 16px}.shared-invite input{min-width:0;padding:12px;font:var(--type-body);background:var(--well);color:var(--text);border:1px solid var(--rule)}.shared-invite .chosen{margin-bottom:0}
@media(prefers-reduced-motion:reduce){.consent-actions .opt-in{transition:none}}
@media(max-width:600px){.shared-invite form{flex-direction:column;align-items:stretch}main{padding:0 20px;margin-top:60px}nav{gap:6px;margin-bottom:32px}nav button{font-size:12px;gap:6px}.number{width:20px;height:20px}h1{font-size:30px}.intro{font-size:15px}}
</style>
