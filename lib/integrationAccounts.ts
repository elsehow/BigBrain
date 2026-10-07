import { integrationLibrary, addLibraryIntegration, hasAccountPolicy } from "./integrationLibrary";
/** Independent connection and live access for each configured account; a connected account is remembered. */
import type { startGranolaSignIn } from './granolaMcp';
import { applyConfig } from './config';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountFingerprint, accountPolicy, writeAccountPolicy, removeAccountPolicy, integrationAccounts, integrationCallerChoices, connectedPolicy, defaultGrants, MANAGED_INTEGRATIONS, type AccountGrant, type Backfill, type GrantCaller, type LiveAccess } from './integrationAccess';
import { probeInbox, probeGmail, type InboxProbe } from './imapProbe';
import { emailConfig, passwordEnvKey, gmailReadOnly, isGmailInbox, parseInboxAdd } from "./emailConfig";
import { readEmailState } from "./emailState";
import { writeAtomic } from './fsx';
import { extraAccounts, integrationAccountEnvKey, integrationAccountKey } from './integrationAccess';
import { readEnvValues, writeEnvValues } from './envFile';
import { loadManifest } from './manifest';
import { ThatTracksClient } from './thatTracks';
import { configuredFeeds, feedUrl, writeFeeds } from './rssConfig';
import { fetchFeed, type Feed } from './rssFeed';
import { integrationNamed } from './integrations';
/** How an integration's accounts sign in through the browser, when they do. */
const browserSignIn=(name:string)=>integrationNamed(name)?.credential.signIn;
type StartSignIn=(root:string,account:string,onConnected:()=>void)=>Promise<unknown>;
/** What live access an account offers: none without tools, and no writes without write tools or where the provider forbids them. */
function offered(root:string,name:string,account:string){
  const i=integrationNamed(name),writes=!!i?.tools.some(t=>t.access==='write')&&(i.writable?.(root,account)??true);
  return {read:!!i?.tools.length,write:writes,capabilities:i?.live?{...i.live,...(writes?{}:{write:null})}:{read:null,write:null}};
}
export function configuredAccounts(root:string){
  const inboxes=emailConfig(loadManifest(root).integrations.email).inboxes;
  return [...MANAGED_INTEGRATIONS].flatMap(name=>integrationAccounts(root,name).map(account=>({name,account,...accountPolicy(root,name,account),
    label:(name==='rss'?configuredFeeds(root).find(f=>f.url===account)?.title:extraAccounts(root,name).find(a=>a.id===account)?.label) ?? account,removable:name==='email'||account!==name,...(name==='email'?{gmail:gmailReadOnly(root,account),google:inboxes.some(i=>i.address===account&&isGmailInbox(i)),host:inboxes.find(i=>i.address===account)?.host,sync:readEmailState(root).inboxes[account]?.last}:{}),capabilities:offered(root,name,account).capabilities,...signInRow(root,name,account)})));
}
/** A browser sign-in's part of an account row: that it signs in so, the flow under way, who is signed in, and whether it must sign in again. */
function signInRow(root:string,name:string,account:string){
  const signIn=browserSignIn(name);if(!signIn)return {};
  return {...(name==='granola'?{transport:'mcp'}:{}),signIn:true,auth:signIn.status(root,account),identity:signIn.identity(root,account),...(signIn.lapsed?.(root,account)?{reconnect:true}:{})};
}
function backfill(since:unknown):Backfill{
  if(typeof since!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(since)||!Number.isFinite(Date.parse(since))||new Date(since).toISOString().slice(0,10)!==since||since>new Date().toISOString().slice(0,10))throw Error('Choose a past history start date.');
  return {since:new Date(since).toISOString(),request:crypto.randomUUID()};
}
export class IntegrationAccounts {
  constructor(readonly root:string,private probes:{email?:InboxProbe;granolaSignIn?:typeof startGranolaSignIn;signIn?:Record<string,StartSignIn>;tracks?:(key:string)=>Promise<unknown>;rss?:(url:string)=>Promise<Feed>}={}){}
  list(){return {destination:basename(this.root),library:integrationLibrary(this.root),accounts:configuredAccounts(this.root),callers:integrationCallerChoices(this.root)};}
  async update(value:any):Promise<ReturnType<IntegrationAccounts["list"]> & {checked?:boolean}>{
    const {name,account,action}=value,signIn=browserSignIn(name);
    if(action==='install') {
      // New additions start at the defaults; existing account choices never change on upgrade or re-add.
      if(signIn&&!hasAccountPolicy(this.root,name,name))writeAccountPolicy(this.root,name,name,{...accountPolicy(this.root,name,name),grants:defaultGrants(name)});
      addLibraryIntegration(this.root,name);
      return this.list();
    }
    if(name==='email' && action==='add') {
      const add=parseInboxAdd({address:value.address,host:'imap.gmail.com',password:typeof value.password==='string'?value.password.replace(/ /g,''):value.password,provider:'gmail'});
      if(!/^[a-zA-Z0-9]{16}$/.test(add.password))throw Error('Enter the 16-character Google app password.');
      if(integrationAccounts(this.root,'email').some(a=>a===add.address||passwordEnvKey(a)===passwordEnvKey(add.address)))throw Error('This email account already exists and is listed above. Reconnect it there with a new app password, or remove it.');
      const revision=JSON.stringify(integrationAccounts(this.root,'email'));
      await (this.probes.email??probeGmail)({...add});
      if(revision!==JSON.stringify(integrationAccounts(this.root,'email')))throw Error('Accounts changed during connection. Try again.');
      applyConfig({integrations:[{name:'email',add:{address:add.address,host:add.host,password:add.password,provider:'gmail'}}]},this.root);
      const policy=accountPolicy(this.root,'email',add.address);
      writeAccountPolicy(this.root,'email',add.address,{...policy,connected:true,fingerprint:accountFingerprint(this.root,'email',add.address),checkedAt:new Date().toISOString(),grants:defaultGrants('email'),email:{startAt:new Date().toISOString(),attachments:false}});
      addLibraryIntegration(this.root,'email');
      return this.list();
    }
    if(name==='rss'&&action==='add'){
      // a feed is checked by reading it: it must answer, and be RSS or Atom
      const url=feedUrl(value.url??value.label),feeds=configuredFeeds(this.root);
      if(feeds.some(f=>f.url===url))throw Error('This feed is already listed above.');
      const feed=await (this.probes.rss??fetchFeed)(url);
      writeFeeds(this.root,[...feeds,{url,title:feed.title}],`config: add the RSS feed ${feed.title}`);
      addLibraryIntegration(this.root,'rss');
      writeAccountPolicy(this.root,'rss',url,{...accountPolicy(this.root,'rss',url),connected:true,fingerprint:accountFingerprint(this.root,'rss',url),checkedAt:new Date().toISOString(),grants:defaultGrants('rss')});
      return this.list();
    }
    if(action==='add'){
      if(!(signIn||name==='that-tracks')||typeof value.label!=='string'||!value.label.trim()||value.label.length>120||(!signIn&&(typeof value.key!=='string'||!value.key.trim()||value.key.length>8000)))throw Error('Choose a source, account name, and API key.');
      const id='account-'+crypto.randomUUID().replaceAll('-','').slice(0,16);
      if(!signIn)writeEnvValues(this.root,{[integrationAccountEnvKey(name,id)]:value.key.trim()});
      writeAtomic(join(this.root,'.spool','integration-accounts',name,'accounts.json'),JSON.stringify([...extraAccounts(this.root,name),{id,label:value.label.trim()}])+'\n',0o600);
      if(signIn)writeAccountPolicy(this.root,name,id,{...accountPolicy(this.root,name,id),grants:defaultGrants(name)});
      return this.list();
    }
    if(!MANAGED_INTEGRATIONS.has(name)||!integrationAccounts(this.root,name).includes(account))throw Error('Choose a configured account.');
    if(action==='remove') {
      // Whatever was configured can be removed, and removal takes its secret and its choices along.
      if(name==='email')applyConfig({integrations:[{name:'email',remove:account}]},this.root);
      else if(name==='rss')writeFeeds(this.root,configuredFeeds(this.root).filter(f=>f.url!==account),'config: remove an RSS feed');
      else {
        if(account===name)throw Error('This account comes with the integration. Disconnect it instead.');
        if(signIn)signIn.disconnect(this.root,account);
        else writeEnvValues(this.root,{[integrationAccountEnvKey(name,account)]:''});
        writeAtomic(join(this.root,'.spool','integration-accounts',name,'accounts.json'),JSON.stringify(extraAccounts(this.root,name).filter(a=>a.id!==account))+'\n',0o600);
      }
      removeAccountPolicy(this.root,name,account);
      return this.list();
    }
    // whether this account had a policy before anything below writes one: only a first connection takes the defaults
    const prior=accountPolicy(this.root,name,account),fresh=!hasAccountPolicy(this.root,name,account);
    if(signIn&&action==='cancel'){signIn.cancel(this.root,account);return this.list();}
    if(signIn&&(action==='connect'||action==='check')){
      writeAccountPolicy(this.root,name,account,{...prior,connected:false});
      const oldIdentity=signIn.identity(this.root,account);
      const start=this.probes.signIn?.[name]??(name==='granola'?this.probes.granolaSignIn:undefined)??signIn.start;
      await start(this.root,account,()=>{
        // signed in as someone else: nobody inherits the earlier account's access
        const current=accountPolicy(this.root,name,account),other=prior.checkedAt&&JSON.stringify(oldIdentity)!==JSON.stringify(signIn.identity(this.root,account));
        writeAccountPolicy(this.root,name,account,connectedPolicy(name,other?{...current,grants:[]}:current,accountFingerprint(this.root,name,account),fresh));
      });
      return this.list();
    }
    if(name==='email' && action==='credentials') {
      const gmail=gmailReadOnly(this.root,account);
      const inbox=emailConfig(loadManifest(this.root).integrations.email).inboxes.find(i=>i.address===account)!;
      // Google shows app passwords in groups of four; the spaces are not part of them.
      const password=typeof value.key==='string'?(isGmailInbox(inbox)?value.key.replace(/ /g,''):value.key.trim()):'';
      if(gmail?!/^[a-zA-Z0-9]{16}$/.test(password):(!password||password.length>8000))throw Error(gmail?'Enter the 16-character Google app password.':'Enter the inbox password.');
      const fingerprint=accountFingerprint(this.root,name,account),snapshot=JSON.stringify(prior);
      await (this.probes.email??(gmail?probeGmail:probeInbox))({address:account,host:inbox.host,port:inbox.port,password});
      if(fingerprint!==accountFingerprint(this.root,name,account)||snapshot!==JSON.stringify(accountPolicy(this.root,name,account)))throw Error('Account settings changed. Try again.');
      writeEnvValues(this.root,{[passwordEnvKey(account)]:password});
      writeAccountPolicy(this.root,name,account,connectedPolicy(name,prior,accountFingerprint(this.root,name,account),fresh));
      return this.list();
    }
    if(action==='credentials'){
      if(name!=='that-tracks'||typeof value.key!=='string'||!value.key.trim()||value.key.length>8000)throw Error('Provide a valid API key.');
      writeEnvValues(this.root,{[integrationAccountEnvKey(name,account)]:value.key.trim()});
      writeAccountPolicy(this.root,name,account,{...prior,connected:false});
      return this.list();
    }
    if(action==='disconnect'){if(signIn)signIn.disconnect(this.root,account);writeAccountPolicy(this.root,name,account,{...prior,connected:false});return this.list();}
    if(action==='check'||action==='connect'){
      const fingerprint=accountFingerprint(this.root,name,account);
      const snapshot=JSON.stringify(prior);
      // Also detect explicit disconnects while a previously-disconnected account is checked.
      const stateSnapshot=()=>{try{return readFileSync(join(this.root,'.spool','integration-account-revision'),'utf8');}catch{return '';}};
      const revision=stateSnapshot();
      if(name==='email'){
        const inbox=emailConfig(loadManifest(this.root).integrations.email).inboxes.find(i=>i.address===account)!;
        const password=readEnvValues(this.root)[passwordEnvKey(account)];if(!password)throw Error('Save the account password first.');
        await (this.probes.email??(gmailReadOnly(this.root,account)?probeGmail:probeInbox))({...inbox,password});
      }else if(name==='rss')await (this.probes.rss??fetchFeed)(account);
      else {
        const key=integrationAccountKey(this.root,name,account);if(!key)throw Error('Save the account API key first.');
        await (this.probes.tracks??(key=>new ThatTracksClient(key).identity()))(key);
      }
      if(fingerprint!==accountFingerprint(this.root,name,account)||snapshot!==JSON.stringify(accountPolicy(this.root,name,account))||revision!==stateSnapshot())throw Error('Account settings changed during the access check. Try again.');
      if(action==='connect')writeAccountPolicy(this.root,name,account,connectedPolicy(name,prior,fingerprint,fresh));
      return {...this.list(),checked:true};
    }
    if(action==='grant')return this.update({name,account,action:'save',grants:[{caller:value.caller,access:value.access}]});
    if(action!=='save')throw Error('Unknown account action.');
    if(!prior.connected)throw Error('Connect this account before changing its settings.');
    if(name==='email' && gmailReadOnly(this.root,account)) {
      const email={...prior.email??{startAt:new Date().toISOString(),attachments:false}};
      if(value.attachments!==undefined) {
        if(typeof value.attachments!=='boolean')throw Error('Choose whether to include attachments.');
        email.attachments=value.attachments;
      }
      if(value.backfillSince)email.backfill=backfill(value.backfillSince);
      prior.email=email;
    }
    if(name==='granola'&&value.backfillSince)prior.granola={...prior.granola,backfill:backfill(value.backfillSince)};
    // One switch for every caller is gone: access is chosen per caller.
    if(value.liveAccess!==undefined)throw Error('Choose live access for each caller.');
    if(value.grants!==undefined){
      const callers=new Set(integrationCallerChoices(this.root).map(c=>c.id)),seen=new Set<string>(),live=offered(this.root,name,account);
      if(!Array.isArray(value.grants)||value.grants.length>100)throw Error('Choose live access for existing callers.');
      const changed:AccountGrant[]=value.grants.map((g:any)=>{
        if(!g||!callers.has(g.caller)||seen.has(g.caller)||!['off','read','read-write'].includes(g.access)||(!live.read&&g.access!=='off')||(!live.write&&g.access==='read-write'))throw Error('Choose a supported access level for an existing caller.');
        seen.add(g.caller);return {caller:g.caller as GrantCaller,access:g.access as LiveAccess};
      });
      // Only the callers named change: saving one caller's access never touches another's. A revoked client's grant goes.
      // When desktops get grants, add desktop:<id> to the choices (or spare it here), or this drops them.
      prior.grants=[...prior.grants.filter(g=>!seen.has(g.caller)&&callers.has(g.caller)),...changed.filter(g=>g.access!=='off')];
    }
    writeAccountPolicy(this.root,name,account,prior);
    return this.list();
  }
}
