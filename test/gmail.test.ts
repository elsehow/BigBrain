import {afterAll,expect,test} from 'bun:test';
import {readFileSync,writeFileSync,existsSync,rmSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {gitVault} from './support/vault';
import {IntegrationAccounts} from '../lib/integrationAccounts';
import {accountPolicy,writeAccountPolicy,requireIntegrationWrite,readableIntegrationAccounts} from '../lib/integrationAccess';
import { emailConfig, passwordEnvKey } from "../lib/emailConfig";
import { readEmailState } from "../lib/emailState";
import {loadManifest} from '../lib/manifest';
import {readEnvValues} from '../lib/envFile';
import {integrationToolCall,integrationCapabilities} from '../lib/integrationTools';
import {createEmailReadStateAdapter} from '../lib/emailReadState';
import {liveInboxTool} from '../lib/liveInbox';
import {admitStaged,passStaged} from '../lib/stage';
import {headFiles} from '../lib/stageStorage';
import {holdElsewhere} from './support/lockElsewhere';
const roots:string[]=[];
afterAll(()=>roots.forEach(root=>rmSync(root,{recursive:true,force:true})));
function vault(){const root=gitVault({files:{'vault.yaml':'{}\n','.gitignore':'.env\n.state/\n.spool/\n'}});roots.push(root);return root;}
async function account(root:string,address='me@example.com'){
 const api=new IntegrationAccounts(root,{email:async()=>{}});
 await api.update({name:'email',action:'add',address,password:'abcd efgh ijkl mnop'});
 return api;
}
async function enable(root:string,options:{attachments?:boolean;startAt?:string}={}){
 const api=await account(root);
 await api.update({name:'email',action:'save',account:'me@example.com',attachments:options.attachments??false});
 const p=accountPolicy(root,'email','me@example.com');
 writeAccountPolicy(root,'email','me@example.com',{...p,email:{...p.email!,startAt:options.startAt??'2026-09-01T00:00:00Z'}});
 return api;
}
async function poll(root:string,config:Record<string,unknown>,args:string[]=[]){
 const fixture=join(root,'fixture.json'),trace=join(root,'trace.jsonl');writeFileSync(fixture,JSON.stringify(config));
 const child=Bun.spawn([process.execPath,'--preload',resolve('test/support/gmailRunnerPreload.ts'),resolve('integrations/email/run.ts'),...args],{cwd:root,env:{...process.env,BIGBRAIN_VAULT:root,GMAIL_TEST_FIXTURE:fixture,GMAIL_TEST_TRACE:trace},stdout:'pipe',stderr:'pipe'});
 const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect(exit,err+out).toBe(0);return out;
}
function body(root:string,id:string){return JSON.parse(readFileSync(join(root,'.spool/stage/email/bodies',id+'.json'),'utf8'));}
test('Gmail onboarding verifies before saving; returns no secrets, keeps choices independent, rejects duplicate legacy account',async()=>{
 const root=vault();let calls=0;
 const api=new IntegrationAccounts(root,{email:async()=>{calls++;throw Error('Rejected');}});
 await expect(api.update({name:'email',action:'add',address:'me@example.com',password:'abcdefghijklmnop'})).rejects.toThrow();
 expect(emailConfig(loadManifest(root).integrations.email).inboxes).toEqual([]);expect(existsSync(join(root,'.env'))).toBe(false);
 const connected=await account(root);expect(calls).toBe(1);
 const state=connected.list();expect(JSON.stringify(state)).not.toContain('abcdefghijklmnop');expect(statSync(join(root,'.env')).mode&0o777).toBe(0o600);
 expect(readableIntegrationAccounts(root,'email',{kind:'pilot'})).toEqual(['me@example.com']); // a new account: Pilot reads
 await connected.update({name:'email',action:'save',account:'me@example.com',grants:[{caller:'pilot',access:'read'}],attachments:false});
 await expect(connected.update({name:'email',action:'save',account:'me@example.com',grants:[{caller:'pilot',access:'read-write'}]})).rejects.toThrow('supported');
 expect(integrationCapabilities(root,{kind:'pilot'}).email.operations).not.toContain('inbox_set_unread');
 expect(()=>requireIntegrationWrite(root,'email','me@example.com',{kind:'pilot'})).toThrow();
 await expect(connected.update({name:'email',action:'add',address:'me@example.com',password:'ponmlkjihgfedcba'})).rejects.toThrow('already exists');
 expect(readEnvValues(root)[passwordEnvKey('me@example.com')]).toBe('abcdefghijklmnop');
});
test('Gmail blocks direct and dispatched writes before connecting, including stored-message writes',async()=>{
 const root=vault();await enable(root);let connections=0;const client=()=>{connections++;throw Error('Must not connect');};
 const ref=Buffer.from(JSON.stringify({account:'me@example.com',uid:1,validity:'1'})).toString('base64url');
 await expect(integrationToolCall(root,{kind:'pilot'},'inbox_set_unread',{ref,unread:false},{client})).rejects.toThrow();
 await expect(liveInboxTool(root,'inbox_set_unread',{ref,unread:false},{client})).rejects.toThrow('read-only');
 await expect(createEmailReadStateAdapter(client).setUnread!(root,{envelope:{source:'email',inbox:'me@example.com',message_id:'<1@x>'}} as any,false)).rejects.toThrow('read-only');
 expect(connections).toBe(0);
});
test('the viewer may flip only \\Seen on a Gmail message; agents stay read-only',async()=>{
 const root=vault();await enable(root);const stored:string[][]=[];const seen=new Set<string>();let lockedReadOnly:boolean|undefined;
 const message=()=>({uid:7,emailId:'100007',envelope:{messageId:'<7@example.com>'},flags:new Set(seen)});
 const client=()=>({mailbox:{readOnly:false},on(){},async connect(){},close(){},
  async list(){return [{path:'[Gmail]/All Mail',specialUse:'\\All'}];},
  async getMailboxLock(_:string,o:{readOnly:boolean}){lockedReadOnly=o.readOnly;return {release(){}};},
  async search(){return [7];},async fetchAll(){return [message()];},async fetchOne(){return message();},
  async messageFlagsAdd(_:number[],flags:string[]){stored.push(flags);flags.forEach(f=>seen.add(f));return true;},
  async messageFlagsRemove(_:number[],flags:string[]){stored.push(flags);flags.forEach(f=>seen.delete(f));return true;}}) as any;
 const source={id:'s',envelope:{source:'email',inbox:'me@example.com',message_id:'<7@example.com>',provider_message_id:'100007'}} as any;
 await expect(createEmailReadStateAdapter(client).setUnread!(root,source,false)).rejects.toThrow('read-only');
 const viewer=createEmailReadStateAdapter(client,{userSeen:true});
 expect((await viewer.read(root,[source])).get('s')).toMatchObject({unread:true,writable:true});
 expect(await viewer.setUnread!(root,source,false)).toMatchObject({unread:false});expect(lockedReadOnly).toBe(false);
 expect(await viewer.setUnread!(root,source,true)).toMatchObject({unread:true});
 expect(stored).toEqual([['\\Seen'],['\\Seen']]);
});
test('one poll at a time: a second skips while another process holds the lock, and polls once that one is killed',async()=>{
 const root=vault();await enable(root);
 const other=await holdElsewhere('sqliteLock.ts','tryHold',[join(root,'.state','email.lock.sqlite')]);
 try{expect(await poll(root,{count:1})).toContain('email: another poll is still running');}
 finally{await other.kill();}
 expect(await poll(root,{count:1})).not.toContain('another poll');
 expect(readEmailState(root).inboxes['me@example.com']?.last?.ok).toBe(true);
});
test('real runner preserves stable identity across UID reset, labels and duplicate Message-IDs; attachment retention is opt-in',async()=>{
 const root=vault();await enable(root);
 await poll(root,{count:2,sameMessageId:true});
 const heads=headFiles(root);expect(heads.length).toBe(2);
 for(const head of heads){expect(body(root,head.id).attachments).toEqual([]);expect(body(root,head.id).content).toContain('provider_message_id:');}
 expect(admitStaged(root,[heads[0]!.id])[0]!.ok).toBe(true);expect(passStaged(root,[heads[1]!.id],'Skip')[0]!.ok).toBe(true);
 await poll(root,{count:3,validity:2,sameMessageId:true,identities:{1:100003,2:100001,3:100002},labels:["Archive project"]});
 expect(headFiles(root).length).toBe(1);
 const policy=accountPolicy(root,'email','me@example.com');writeAccountPolicy(root,'email','me@example.com',{...policy,email:{...policy.email!,attachments:true}});
 await poll(root,{count:4,validity:2});
 expect(headFiles(root).some(h=>body(root,h.id).attachments.length===1)).toBe(true);
 const trace=readFileSync(join(root,'trace.jsonl'),'utf8');expect(trace).toContain('EXAMINE');expect(trace).not.toContain('STORE');
},30000);
test('real runner resumes >5000-message backfill without skipping the tail',async()=>{
 const root=vault();await enable(root);
 const p=accountPolicy(root,'email','me@example.com');
 // Ignore the first 5000 by date; the last remains available next tick.
 await poll(root,{count:5001,internalDate:'2026-08-01T00:00:00Z'},['--since','2026-09-01']);
 expect(readEmailState(root).inboxes['me@example.com']!.lastUid).toBe(5000);
 await poll(root,{count:5001});
 expect(readEmailState(root).inboxes['me@example.com']!.lastUid).toBe(5001);
 expect(headFiles(root).length).toBe(1);expect(accountPolicy(root,'email','me@example.com').fingerprint).toBe(p.fingerprint);
},30000);
test('real runner retries bodies and headers beyond three attempts, survives .state deletion, and stops when disconnected',async()=>{
 const root=vault();await enable(root);
 for(let i=0;i<4;i++)await poll(root,{count:2,failBody:1,missingHeader:2});
 expect(readEmailState(root).inboxes['me@example.com']!.retry).toHaveLength(2);
 rmSync(join(root,'.state'),{recursive:true,force:true});
 await poll(root,{count:2});expect(headFiles(root).length).toBe(2);expect(readEmailState(root).inboxes['me@example.com']!.retry).toEqual([]);
 const p=accountPolicy(root,'email','me@example.com');writeAccountPolicy(root,'email','me@example.com',{...p,connected:false});
 const before=readFileSync(join(root,'.spool/email.json'),'utf8');await poll(root,{count:3});expect(readFileSync(join(root,'.spool/email.json'),'utf8')).toBe(before);
},30000);
test('real runner honors exact initial start and UI backfill request across ticks',async()=>{
 const root=vault();const api=await enable(root,{startAt:'2026-09-25T13:00:00Z'});
 await poll(root,{count:1});expect(headFiles(root)).toHaveLength(0);
 await api.update({name:'email',account:'me@example.com',action:'save',backfillSince:'2026-09-01'});
 await poll(root,{count:1});expect(headFiles(root)).toHaveLength(1);
 expect(readEmailState(root).inboxes['me@example.com']!.backfillRequest).toBe(accountPolicy(root,'email','me@example.com').email!.backfill!.request);
},30000);
test('Gmail installation preserves a legacy account policy and does not overwrite a colliding credential key',async()=>{
 const root=vault();const {applyConfig}=await import('../lib/config');
 applyConfig({integrations:[{name:'email',add:{address:'old+tag@example.com',host:'imap.example.com',password:'legacy-secret'}}]},root);
 const {accountFingerprint}=await import('../lib/integrationAccess');
 const prior={...accountPolicy(root,'email','old+tag@example.com'),connected:true,fingerprint:accountFingerprint(root,'email','old+tag@example.com'),grants:[{caller:'pilot' as const,access:'read-write' as const}]};
 writeAccountPolicy(root,'email','old+tag@example.com',prior);
 const api=new IntegrationAccounts(root,{email:async()=>{}});await api.update({name:'email',action:'install'});
 await expect(api.update({name:'email',action:'add',address:'old.tag@example.com',password:'abcdefghijklmnop'})).rejects.toThrow('already exists');
 await account(root);
 expect(accountPolicy(root,'email','old+tag@example.com')).toEqual(prior);
 expect(()=>requireIntegrationWrite(root,'email','old+tag@example.com',{kind:'pilot'})).not.toThrow();
 expect(readEnvValues(root)[passwordEnvKey('old+tag@example.com')]).toBe('legacy-secret');
});
test('provider identity is account-scoped, missing RFC Message-ID is safe, and legacy matching requires account and exact content',async()=>{
 const {emailItem}=await import('../lib/emailItem');const {emailDiscovered}=await import('../lib/emailDiscovery');const {receive}=await import('../lib/intake');
 const root=vault();await enable(root);
 const head={inbox:'me@example.com',uid:1,messageId:'<same@example.com>',from:'friend@example.com',fromName:'Friend',to:['me@example.com'],subject:'Message 1',date:'2026-09-25T12:00:00.000Z',size:300,bulk:false,auto:false,reply:false,known:false};
 const body={text:'Decision 1.',to:[{address:'me@example.com'}],cc:[],attachments:[]};
 const old=emailItem(head,body,new Date('2026-09-25'));receive({root,content:old.content});
 const modern=emailItem({...head,emailId:'18446744073709551614'},body,new Date('2026-09-26'));
 expect(emailDiscovered(root)({...head,emailId:'18446744073709551614'},modern.id,modern.content)).toBe(true);
 const changed=emailItem({...head,emailId:'18446744073709551614'},{...body,text:'Different decision.'},new Date());
 expect(emailDiscovered(root)(head,changed.id,changed.content)).toBe(false);
 const other=emailItem({...head,inbox:'other@example.com',emailId:'18446744073709551614'},body,new Date());expect(other.id).not.toBe(modern.id);
 expect(emailDiscovered(root)({...head,inbox:'other@example.com'},other.id,other.content)).toBe(false);
 await poll(root,{count:1,noMessageId:true});expect(headFiles(root)).toHaveLength(1);
});
