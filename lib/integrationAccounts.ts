import { integrationLibrary, addLibraryIntegration, hasAccountPolicy } from "./integrationLibrary";
/** Independent connection, remembering, and live access for each configured account. */
import { startGranolaSignIn, cancelGranolaSignIn, granolaSignInStatus, granolaConnection, disconnectGranola } from './granolaMcp';
import { applyConfig } from './config';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountFingerprint, accountPolicy, writeAccountPolicy, removeAccountPolicy, integrationAccounts, integrationCallerChoices, MANAGED_INTEGRATIONS, type LiveAccess } from './integrationAccess';
import { probeInbox, probeGmail, type InboxProbe } from './imapProbe';
import { emailConfig, passwordEnvKey, gmailReadOnly, isGmailInbox, parseInboxAdd } from "./emailConfig";
import { readEmailState } from "./emailState";
import { writeAtomic } from './fsx';
import { extraAccounts, integrationAccountEnvKey, integrationAccountKey } from './integrationAccess';
import { readEnvValues, writeEnvValues } from './envFile';
import { loadManifest } from './manifest';
import { ThatTracksClient } from './thatTracks';
export const LIVE_ACCESS_DESCRIPTIONS = {
  granola:{read:"Read current meeting notes, transcripts and folders via Granola MCP. Does not change meetings or remember evidence.",write:null},
  email:{read:'List inbox messages, read messages and threads, and inspect current read/unread flags. Reads do not mark messages read or save evidence.',write:'Mark specific inbox messages read or unread. Does not send, delete, move, or remember messages.'},
};
export function configuredAccounts(root:string){
  const inboxes=emailConfig(loadManifest(root).integrations.email).inboxes;
  return [...MANAGED_INTEGRATIONS].flatMap(name=>integrationAccounts(root,name).map(account=>({name,account,...accountPolicy(root,name,account),
    label:extraAccounts(root,name).find(a=>a.id===account)?.label ?? account,removable:name==='email'||account!==name,...(name==='email'?{gmail:gmailReadOnly(root,account),google:inboxes.some(i=>i.address===account&&isGmailInbox(i)),host:inboxes.find(i=>i.address===account)?.host,sync:readEmailState(root).inboxes[account]?.last}:{}),capabilities:name==='email'?{...LIVE_ACCESS_DESCRIPTIONS.email,...(gmailReadOnly(root,account)?{write:null}:{})}:name==='granola'?LIVE_ACCESS_DESCRIPTIONS.granola:{read:null,write:null},...(name==='granola'?{transport:'mcp',auth:granolaSignInStatus(root,account),identity:granolaConnection(root,account)?.identity}:{})})));
}
export class IntegrationAccounts {
  constructor(readonly root:string,private probes:{email?:InboxProbe;granolaSignIn?:typeof startGranolaSignIn;tracks?:(key:string)=>Promise<unknown>}={}){}
  list(){return {destination:basename(this.root),library:integrationLibrary(this.root),accounts:configuredAccounts(this.root),callers:integrationCallerChoices(this.root)};}
  async update(value:any):Promise<ReturnType<IntegrationAccounts["list"]> & {checked?:boolean}>{
    const {name,account,action}=value;
    if(action==='install') {
      // New additions opt in; existing account choices never change on upgrade or re-add.
      if(name==='granola'&&!hasAccountPolicy(this.root,name,name)) {
        const policy=accountPolicy(this.root,name,name);
        writeAccountPolicy(this.root,name,name,{...policy,liveAccess:true,remembering:{...policy.remembering,enabled:true}});
      }
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
      writeAccountPolicy(this.root,'email',add.address,{...policy,connected:true,fingerprint:accountFingerprint(this.root,'email',add.address),checkedAt:new Date().toISOString(),liveAccess:false,remembering:{enabled:false},email:{startAt:new Date().toISOString(),attachments:false}});
      addLibraryIntegration(this.root,'email');
      return this.list();
    }
    if(action==='add'){
      if(!['granola','that-tracks'].includes(name)||typeof value.label!=='string'||!value.label.trim()||value.label.length>120||(name!=='granola'&&(typeof value.key!=='string'||!value.key.trim()||value.key.length>8000)))throw Error('Choose a source, account name, and API key.');
      const id='account-'+crypto.randomUUID().replaceAll('-','').slice(0,16);
      if(name!=='granola')writeEnvValues(this.root,{[integrationAccountEnvKey(name,id)]:value.key.trim()});
      writeAtomic(join(this.root,'.spool','integration-accounts',name,'accounts.json'),JSON.stringify([...extraAccounts(this.root,name),{id,label:value.label.trim()}])+'\n',0o600);
      if(name==='granola') {
        const policy=accountPolicy(this.root,name,id);
        writeAccountPolicy(this.root,name,id,{...policy,liveAccess:true,remembering:{...policy.remembering,enabled:true}});
      }
      return this.list();
    }
    if(!MANAGED_INTEGRATIONS.has(name)||!integrationAccounts(this.root,name).includes(account))throw Error('Choose a configured account.');
    if(action==='remove') {
      // Whatever was configured can be removed, and removal takes its secret and its choices along.
      if(name==='email')applyConfig({integrations:[{name:'email',remove:account}]},this.root);
      else {
        if(account===name)throw Error('This account comes with the integration. Disconnect it instead.');
        if(name==='granola')disconnectGranola(this.root,account);
        else writeEnvValues(this.root,{[integrationAccountEnvKey(name,account)]:''});
        writeAtomic(join(this.root,'.spool','integration-accounts',name,'accounts.json'),JSON.stringify(extraAccounts(this.root,name).filter(a=>a.id!==account))+'\n',0o600);
      }
      removeAccountPolicy(this.root,name,account);
      return this.list();
    }
    const prior=accountPolicy(this.root,name,account);
    if(name==='granola'&&action==='cancel'){cancelGranolaSignIn(this.root,account);return this.list();}
    if(name==='granola'&&(action==='connect'||action==='check')){
      writeAccountPolicy(this.root,name,account,{...prior,connected:false});
      const oldIdentity=granolaConnection(this.root,account)?.identity;
      await (this.probes.granolaSignIn??startGranolaSignIn)(this.root,account,()=>{
        const current=accountPolicy(this.root,name,account);
        writeAccountPolicy(this.root,name,account,{...current,...(prior.checkedAt && JSON.stringify(oldIdentity)!==JSON.stringify(granolaConnection(this.root,account)?.identity)?{liveAccess:false,grants:[],remembering:{enabled:false}}:{}),connected:true,fingerprint:accountFingerprint(this.root,name,account),checkedAt:new Date().toISOString()});
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
      writeAccountPolicy(this.root,name,account,{...prior,connected:true,fingerprint:accountFingerprint(this.root,name,account),checkedAt:new Date().toISOString()});
      return this.list();
    }
    if(action==='credentials'){
      if(name!=='that-tracks'||typeof value.key!=='string'||!value.key.trim()||value.key.length>8000)throw Error('Provide a valid API key.');
      writeEnvValues(this.root,{[integrationAccountEnvKey(name,account)]:value.key.trim()});
      writeAccountPolicy(this.root,name,account,{...prior,connected:false});
      return this.list();
    }
    if(action==='disconnect'){if(name==='granola')disconnectGranola(this.root,account);writeAccountPolicy(this.root,name,account,{...prior,connected:false});return this.list();}
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
      }else {
        const key=integrationAccountKey(this.root,name,account);if(!key)throw Error('Save the account API key first.');
        await (this.probes.tracks??(key=>new ThatTracksClient(key).identity()))(key);
      }
      if(fingerprint!==accountFingerprint(this.root,name,account)||snapshot!==JSON.stringify(accountPolicy(this.root,name,account))||revision!==stateSnapshot())throw Error('Account settings changed during the access check. Try again.');
      if(action==='connect')writeAccountPolicy(this.root,name,account,{...prior,connected:true,fingerprint,checkedAt:new Date().toISOString()});
      return {...this.list(),checked:true};
    }
    if(action==='grant')return this.update({name,account,action:'save',remembering:prior.remembering,grants:[...prior.grants.filter(g=>g.caller!==value.caller&&integrationCallerChoices(this.root).some(c=>c.id===g.caller)),{caller:value.caller,access:value.access}]});
    if(action!=='save')throw Error('Unknown account action.');
    if(!prior.connected)throw Error('Connect this account before changing access or remembering.');
    const remembering=value.remembering;
    if(!remembering||typeof remembering.enabled!=='boolean')throw Error('Choose whether to remember this account.');
    if(name==='email' && gmailReadOnly(this.root,account)) {
      const email={...prior.email??{startAt:new Date().toISOString(),attachments:false}};
      if(!prior.remembering.enabled && remembering.enabled && !prior.email)email.startAt=new Date().toISOString();
      if(value.attachments!==undefined) {
        if(typeof value.attachments!=='boolean')throw Error('Choose whether to include attachments.');
        email.attachments=value.attachments;
      }
      if(value.backfillSince) {
        if(typeof value.backfillSince!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.backfillSince)||!Number.isFinite(Date.parse(value.backfillSince))||new Date(value.backfillSince).toISOString().slice(0,10)!==value.backfillSince||value.backfillSince>new Date().toISOString().slice(0,10))throw Error('Choose a past history start date.');
        if(!remembering.enabled)throw Error('Enable remembering before requesting history.');
        email.backfill={since:new Date(value.backfillSince).toISOString(),request:crypto.randomUUID()};
      }
      prior.email=email;
    }
    if(value.liveAccess!==undefined){
      if(typeof value.liveAccess!=='boolean'||(name==='that-tracks'&&value.liveAccess))throw Error('Choose supported live access.');
      writeAccountPolicy(this.root,name,account,{...prior,liveAccess:value.liveAccess,grants:[],remembering:{enabled:remembering.enabled}});
      return this.list();
    }
    const callers=new Set(integrationCallerChoices(this.root).map(c=>c.id)),seen=new Set<string>();
    if(!Array.isArray(value.grants)||value.grants.length>100)throw Error('Choose live access for existing callers.');
    const grants=value.grants.map((g:any)=>{
      if(!g||!callers.has(g.caller)||seen.has(g.caller)||!['off','read','read-write'].includes(g.access)||(name==='that-tracks'&&g.access!=='off')||((name==='granola'||(name==='email'&&gmailReadOnly(this.root,account)))&&g.access==='read-write'))throw Error('Choose a supported access level for an existing caller.');
      seen.add(g.caller);return {caller:g.caller,access:g.access as LiveAccess};
    });
    writeAccountPolicy(this.root,name,account,{...prior,remembering:{enabled:remembering.enabled},grants});
    return this.list();
  }
}
