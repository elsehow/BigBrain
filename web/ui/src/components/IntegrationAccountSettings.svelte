<script lang="ts">
  import { vaultFetch as fetch } from "../lib/vaultScope";

 /** Every integration's account settings, one component, one contract:
  * 1. Whatever is configured is listed here and can be removed here — a
  *    thing that exists but cannot be seen or undone reads as a bug.
  * 2. Save is never silently disabled. If something is missing, clicking
  *    Save says what, in one line.
  * 3. Feedback appears beside the control that produced it: Saved. next to
  *    Save, connection errors next to Connect, add errors under the form.
  * 4. Removal asks once, inline, and takes the secret and the choices along.
  * docs/design-principles.md, "Integration settings". */
 import {openExternal} from "../lib/native";
 import IntegrationReads from "./IntegrationReads.svelte";
 import {onMount} from 'svelte';
 const {source}:{source:string}=$props();
  type Account={gmail?:boolean;google?:boolean;host?:string;removable?:boolean;email?:{startAt:string;attachments:boolean;backfill?:{since:string}};granola?:{backfill?:{since:string}};sync?:{ok:boolean;error?:string};auth?:{phase:string;url?:string;error?:string};identity?:unknown;label:string;name:string;account:string;connected:boolean;grants?:{caller:string;access:Access}[];capabilities:{read:string|null;write:string|null}};
 let newLabel=$state(''),newKey=$state(''),adding=$state(false),destination=$state('this vault');
 let history=$state<Record<string,string>>({});
 let includeHistory=$state<Record<string,boolean>>({});
 const items=$derived(source==='granola'?'meetings':'mail');
 let keys=$state<Record<string,string>>({});
 let expanded=$state<Record<string,boolean>>({});
 let removing=$state<Record<string,boolean>>({});
 let accounts=$state<Account[]>([]),busy=$state(false);
 /** Live access, per caller: Pilot, then each connected client. Save sends only what was changed here, so it never undoes another caller's grant. */
 type Access='off'|'read'|'read-write';
 let callers=$state<{id:string;label:string;expired?:boolean}[]>([]);
 let changed=$state<Record<string,Record<string,Access>>>({});
 const granted=(account:Account,caller:string):Access=>account.grants?.find(g=>g.caller===caller)?.access??'off';
 const accessOf=(account:Account,caller:string):Access=>changed[account.account]?.[caller]??granted(account,caller);
 const grantChanges=(account:Account)=>{const c=Object.entries(changed[account.account]??{});return c.length?{grants:c.map(([caller,access])=>({caller,access}))}:{};};
 type Where='connection'|'save'|'list'|'add';
 /** One message at a time, shown where the action happened. */
 let feedback=$state<{where:Where;account:string|null;error:boolean;text:string}|null>(null);
 function say(where:Where,account:string|null,text:string,error=false){feedback={where,account,error,text};}
 const placeOf=(action:string):Where=>action==='save'?'save':action==='remove'?'list':'connection';
 async function request(body?:unknown){const r=await fetch('/api/integration-accounts',body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);const v=await r.json();if(!r.ok)throw Error(v.error||'Could not load account settings.');return v;}
 function accountLabel(account:Account){
   if(account.label!==source)return account.label;
   const identity=account.identity as {email?:unknown}|undefined;
   return typeof identity?.email==='string'?identity.email:'Account';
 }
 function accept(v:{accounts:Account[];destination?:string;callers?:{id:string;label:string;expired?:boolean}[]}){destination=v.destination??"this vault";accounts=v.accounts.filter(a=>a.name===source);callers=v.callers??[];
  // a change the server now holds is no longer pending
  for(const a of accounts)for(const [caller,access] of Object.entries(changed[a.account]??{}))if(granted(a,caller)===access)delete changed[a.account]![caller];}
 onMount(()=>{
   void request().then(accept).catch(e=>say('list',null,e.message,true));
   const timer=setInterval(()=>{if(!busy&&accounts.some(a=>a.auth?.phase==='browser'||a.auth?.phase==='starting'))void request().then(accept).catch(e=>say('list',null,e.message,true));},1500);
   return()=>clearInterval(timer);
 });
 async function act(account:Account,action:string){busy=true;feedback=null;const where=placeOf(action),who=action==='remove'?null:account.account;const importing=(source==='email'||source==='granola')&&includeHistory[account.account]?history[account.account]:'';try{accept(await request({name:source,account:account.account,action,key:keys[account.account],...(action==='save'?grantChanges(account):{}),...(source==='email'?{attachments:account.email?.attachments??false}:{}),...(source==='email'||source==='granola'?{backfillSince:includeHistory[account.account]?history[account.account]:undefined}:{})}));if(action==='credentials')keys[account.account]='';if(action==='save'){includeHistory[account.account]=false;history[account.account]='';}if(source==='granola'&&action==='connect'){const url=accounts.find(a=>a.account===account.account)?.auth?.url;if(url)await openExternal(url);}say(where,who,action==='connect'?(accounts.find(a=>a.account===account.account)?.connected?'Connected.':'Finish sign-in in your browser.'):action==='disconnect'?'Disconnected.':action==='cancel'?'Sign-in cancelled.':action==='remove'?`Removed ${accountLabel(account)}.`:importing?`Saved. Importing ${items} since ${importing}.`:'Saved.');}catch(e){say(where,who,e instanceof Error?e.message:'Could not save.',true);}finally{busy=false;if(action==='credentials'&&source==='email')keys[account.account]='';}}
 /** A calendar date typed as YYYY-MM-DD, today or earlier; '' when it is not one. */
 function pastDate(text:string):string{
  const t=text.trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(t))return '';
  const ms=Date.parse(t+'T00:00:00Z');
  return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===t&&t<=new Date().toISOString().slice(0,10)?t:'';
 }
 /** Save is never silently disabled: what is missing is said, in one line. */
 function save(account:Account){
  const since=history[account.account]??'';
  const missing=includeHistory[account.account]&&!since.trim()?`Enter the date to remember ${items} since, or untick Import earlier ${items}.`
   :includeHistory[account.account]&&!pastDate(since)?'Enter the date as YYYY-MM-DD, today or earlier.':'';
  if(missing){say('save',account.account,missing,true);return;}
  if(includeHistory[account.account])history[account.account]=pastDate(since);
  void act(account,'save');
 }
 async function add(){busy=true;feedback=null;try{accept(await request({name:source,action:'add',label:newLabel,key:newKey,...(source==='email'?{address:newLabel,password:newKey}:source==='rss'?{url:newLabel}:{})}));newLabel='';newKey='';adding=false;say('list',null,source==='email'?'Connected. New mail is remembered; choose live access below.':source==='rss'?'Feed added. New items arrive within 15 minutes.':'Account added. Check and connect it to verify access.');}catch(e){say('add',null,e instanceof Error?e.message:'Could not add account.',true);}finally{busy=false;if(source==='email')newKey='';}}
</script>
{#snippet note(where:Where,account:string|null)}{#if feedback&&feedback.where===where&&feedback.account===account}<p class="note" role={feedback.error?'alert':'status'}>{feedback.text}</p>{/if}{/snippet}
<section class="settings-list account-list" aria-label={`${source} accounts`}>
 {#each accounts as account(account.account)}<details bind:open={expanded[account.account]} class="settings-row account-row"><summary><strong>{accountLabel(account)}</strong><span>{account.connected ? "Connected" : "Not connected"}</span></summary>
  <div class="account-settings">
  <div class="account-connection">
  {#if source==='email'}<details><summary>{account.google?'App password':'Password'}</summary><label>{account.google?'New app password':'New password'}<input type="password" autocomplete="new-password" bind:value={keys[account.account]} placeholder={account.google?'16-character Google app password':'Inbox password'}/></label><button disabled={busy||!keys[account.account]?.trim()} onclick={()=>act(account,'credentials')}>Reconnect</button></details>{/if}
  {#if source==='that-tracks'}<details><summary>Credentials</summary><label>API key<input type="password" autocomplete="new-password" bind:value={keys[account.account]} placeholder="Leave blank to keep the saved key"/></label><button disabled={busy||!keys[account.account]?.trim()} onclick={()=>act(account,'credentials')}>Save key</button></details>{/if}
  {#if source==='granola'&&account.identity}<details><summary>Signed-in account</summary><pre>{typeof account.identity==='string'?account.identity:JSON.stringify(account.identity,null,2)}</pre></details>{/if}
  {#if account.auth?.phase==='browser'}
    <div class="actions"><button onclick={()=>account.auth?.url&&openExternal(account.auth.url)}>Continue sign-in</button><button disabled={busy} onclick={()=>act(account,'cancel')}>Cancel</button></div>
  {:else if !account.connected}<button disabled={busy} onclick={()=>act(account,'connect')}>Connect</button>{:else}<button disabled={busy} onclick={()=>act(account,'disconnect')}>Disconnect</button>{/if}
  {#if account.auth?.error}<p role="alert">{account.auth.error}</p>{/if}
  {@render note('connection',account.account)}
  </div>
  {#if source==='email'}<p>{account.gmail?'Gmail · Inbox, sent and archive. Agents only read; you can mark mail read or unread. No sending or other mailbox changes.':account.google?'Gmail over IMAP · Inbox, sent and archive.':`IMAP inbox at ${account.host}.`}</p>{#if account.sync&&!account.sync.ok}<p role="status">{account.sync.error}</p>{/if}{/if}
  {#if account.removable}{#if removing[account.account]}<div class="actions"><p>Remove {accountLabel(account)} from {destination}? {source==='email'?'Its saved password and choices go with it; remembered mail stays.':'Its saved credentials and choices go with it; remembered material stays.'}</p><button disabled={busy} onclick={()=>{removing[account.account]=false;void act(account,'remove');}}>Remove</button><button disabled={busy} onclick={()=>removing[account.account]=false}>Keep</button></div>
  {:else}<button disabled={busy} onclick={()=>removing[account.account]=true}>Remove…</button>{/if}{/if}
  <fieldset disabled={busy||!account.connected}>
   {#if source==='email'}<div class="remembering-rule"><p>{account.email?.backfill ? `Mail since ${account.email.backfill.since.slice(0,10)}` : "New mail from connection"} is staged locally, then remembered in {destination} unless the worth gate scores it as not worth keeping.</p>
   <details><summary>History and attachments</summary>
    <label class="toggle"><input type="checkbox" bind:checked={includeHistory[account.account]}/> Import earlier mail</label>
    {#if includeHistory[account.account]}<label>Remember mail since<input inputmode="numeric" autocomplete="off" placeholder="YYYY-MM-DD" bind:value={history[account.account]}/></label>{#if !pastDate(history[account.account]??'')}<p>A date such as {new Date(Date.now()-90*864e5).toISOString().slice(0,10)}. Mail from that day on is staged for review.</p>{/if}{/if}
    {#if account.email}<label class="toggle"><input type="checkbox" bind:checked={account.email.attachments}/> Include attachments in future imports</label>{/if}
    <p>Attachments are off by default.</p>
   </details></div>{/if}

   {#if source==='granola'}<div class="remembering-rule"><p>{account.granola?.backfill ? `Meetings since ${account.granola.backfill.since.slice(0,10)}` : "New meetings from connection"} are staged locally, then remembered in {destination} unless the worth gate scores them as not worth keeping.</p>
   <details><summary>History</summary>
    <label class="toggle"><input type="checkbox" bind:checked={includeHistory[account.account]}/> Import earlier meetings</label>
    {#if includeHistory[account.account]}<label>Remember meetings since<input inputmode="numeric" autocomplete="off" placeholder="YYYY-MM-DD" bind:value={history[account.account]}/></label>{#if !pastDate(history[account.account]??'')}<p>A date such as {new Date(Date.now()-90*864e5).toISOString().slice(0,10)}. Meetings from that day on are staged for review.</p>{/if}{/if}
   </details></div>{/if}
  </fieldset>
  {#if account.capabilities.read}<fieldset class="live-access" disabled={busy||!account.connected}>
    <legend>Live access</legend>
    <p>{account.capabilities.read}{account.capabilities.write ? ' '+account.capabilities.write : ''}</p>
    <ul aria-label={`Live access to ${accountLabel(account)}`}>{#each callers as caller(caller.id)}<li><span>{caller.label}{#if caller.expired}<span class="lapsed">{' · expired'}</span>{/if}</span><select aria-label={`Live access for ${caller.label}`} value={accessOf(account,caller.id)} onchange={e=>(changed[account.account]??={})[caller.id]=e.currentTarget.value as Access}><option value="off">Off</option><option value="read">Read</option>{#if account.capabilities.write}<option value="read-write">Read and write</option>{/if}</select></li>{/each}</ul>
    <p>Pilot is BigBrain’s own agent and has no shell. An external agent with access can act on what it reads with its own tools. This controls what BigBrain hands it.</p>
  </fieldset>{/if}
  <div class="actions"><button disabled={busy||!account.connected} onclick={()=>save(account)}>Save</button>{@render note('save',account.account)}</div>
  {#if account.capabilities.read}<IntegrationReads integration={source} account={account.account}/>{/if}
 </div></details>{/each}
 {@render note('list',null)}
 {#if source==='email'}
  {#if accounts.length}<button class="settings-add" onclick={()=>adding=!adding}>{adding?'Cancel':'New account +'}</button>{/if}
  {#if adding||!accounts.length}<form onsubmit={e=>{e.preventDefault();void add();}}>
   <p>Connect with a Google app password. Requires 2-Step Verification and an eligible Google account.</p>
   <label>Email address<input type="email" autocomplete="username" bind:value={newLabel} placeholder="you@gmail.com" required/></label>
   <label>App password<input type="password" autocomplete="new-password" bind:value={newKey} placeholder="16-character Google app password" required/></label>
   <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Create an app password ↗</a>
   <details><summary>Can’t create an app password?</summary><p>Google may restrict app passwords for work accounts, security-key-only sign-in or Advanced Protection. Your usual Google password won’t work.</p></details>
   <button disabled={busy||!newLabel.trim()||!newKey.trim()}>{busy?'Connecting…':'Connect'}</button>
  </form>{/if}{@render note('add',null)}
 {/if}
 {#if source==='rss'}
  {#if accounts.length}<button class="settings-add" onclick={()=>adding=!adding}>{adding?'Cancel':'New feed +'}</button>{/if}
  {#if adding||!accounts.length}<form onsubmit={e=>{e.preventDefault();void add();}}>
   <label>Feed address<input type="url" autocomplete="off" bind:value={newLabel} placeholder="https://example.com/feed.xml" required/></label>
   <button disabled={busy||!newLabel.trim()}>{busy?'Checking…':'Add feed'}</button>
  </form>{/if}{@render note('add',null)}
 {/if}
 {#if source!=='email'&&source!=='that-tracks'&&source!=='rss'}<button class="settings-add" onclick={()=>adding=!adding}>{adding ? 'Cancel' : 'New account +'}</button>{#if adding}<form onsubmit={e=>{e.preventDefault();void add();}}><label>Account name<input bind:value={newLabel} maxlength="120"/></label>{#if source!=='granola'}<label>API key<input type="password" autocomplete="new-password" bind:value={newKey}/></label>{/if}<button disabled={busy||!newLabel.trim()||(source!=='granola'&&!newKey.trim())}>Add account</button></form>{/if}{@render note('add',null)}{/if}
</section>
<style>
 .account-list{box-sizing:border-box;padding-left:20px;border-left:1px solid var(--rule);margin-top:20px}
 .account-list .account-row{padding:0;border:1px solid var(--rule)}
 .account-list .account-row > summary{padding:14px 16px;background:var(--well);margin:0}
 .account-row > summary > strong{font-weight:500}
 .account-list .account-settings{padding:20px 24px;gap:20px}
 .account-connection{display:flex;align-items:start;flex-wrap:wrap;gap:16px;justify-content:space-between}
 .account-connection > details{flex:1;min-width:0}
 .account-settings > fieldset{border-top:1px solid var(--rule);padding-top:20px}
 .remembering-rule{margin-left:28px}
 .live-access legend{float:left;width:100%;padding:0;font:var(--type-body);font-weight:500;color:var(--text-strong)}
 .live-access ul{display:grid;margin:0;padding:0;list-style:none;border-top:1px solid var(--rule)}
 .live-access li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:8px 0;border-bottom:1px solid var(--rule);font:var(--type-body);min-width:0}
 .live-access li > span{flex:1 1 10em;min-width:0;overflow-wrap:break-word}
 .live-access .lapsed{color:var(--text-muted)}
 .live-access select{flex:none;padding:6px 8px;font:inherit;background:var(--well);color:var(--text);border:1px solid var(--rule)}
 .live-access select:focus-visible{outline:2px solid var(--activity);outline-offset:3px}
 @media(max-width:700px){.account-list{padding-left:12px}.account-list .account-settings{padding:16px}.remembering-rule{margin-left:0}}

 section,.account-settings,fieldset,label,form{display:grid;gap:12px;min-width:0}fieldset{border:0;padding:12px 0;margin:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:var(--type-meta)}.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}p{margin:0}p{font:var(--type-meta);color:var(--text-muted)}label{font:var(--type-body)}input[type=email],input[type=password],input:not([type]){box-sizing:border-box;width:100%;padding:10px;background:var(--well);color:var(--text);font:inherit;border:1px solid var(--rule)}.toggle{display:flex;align-items:center}button{justify-self:start;font:var(--type-body);padding:8px 12px;border:1px solid var(--rule);background:transparent;color:var(--text-strong);cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid var(--activity);outline-offset:3px}[role=alert]{color:var(--err)}
</style>
