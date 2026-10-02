import {afterEach,expect,test} from 'bun:test';
import {join} from 'node:path';
import {readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {nativeVault,gitVault} from './support/vault';
import {readEnvValues} from '../lib/envFile';
import {IntegrationAccounts} from '../lib/integrationAccounts';
import {accountPolicy,integrationActive,readableIntegrationAccounts,requireIntegrationWrite} from '../lib/integrationAccess';
import {stagedHeads,admitStaged} from '../lib/stage';
import {stage} from '../lib/stageStorage';
import {nextWork} from '../lib/work';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})));
function fixture(){const root=nativeVault({files:{'vault.yaml':'integrations:\n  email:\n    inboxes:\n      - address: personal@example.com\n        host: imap.example.com\n      - address: work@example.com\n        host: imap.example.com\n','.env':'BIGBRAIN_IMAP_PASSWORD__PERSONAL_EXAMPLE_COM=one\nBIGBRAIN_IMAP_PASSWORD__WORK_EXAMPLE_COM=two\n'}});roots.push(root);const calls:string[]=[];return {root,calls,accounts:new IntegrationAccounts(root,{email:async i=>{calls.push(i.address);}})};}
test('two inboxes independently connect, remember, grant live access, and disconnect',async()=>{
 const {root,accounts,calls}=fixture(),a='personal@example.com',b='work@example.com';
 const act=(account:string,action:string,extra={})=>accounts.update({name:'email',account,action,...extra});
 await act(a,'connect');await act(b,'connect');expect(calls).toEqual([a,b]);
 expect(integrationActive(root,'email')).toBe(false);expect(readableIntegrationAccounts(root,'email',{kind:'pilot'})).toEqual([]);
 await act(a,'save',{remembering:{enabled:false,rule:''},grants:[{caller:'pilot',access:'read-write'}]});
 await act(b,'save',{remembering:{enabled:true,rule:'Remember work decisions only.'},grants:[]});
 expect(readableIntegrationAccounts(root,'email',{kind:'pilot'})).toEqual([a]);expect(()=>requireIntegrationWrite(root,'email',a,{kind:'pilot'})).not.toThrow();expect(()=>requireIntegrationWrite(root,'email',b,{kind:'pilot'})).toThrow();
 for(const account of [a,b])stage(root,{id:account===a?'personal':'work',source:'email',account,at:'2026-09-23',line:'Decision',scopes:{},name:'mail.md',content:'---\nsource: email\n---\nA decision.'});
 expect(stagedHeads(root).map(h=>h.account)).toEqual([b]);expect(nextWork(root,{kinds:['staged']})[0]?.inputs).toEqual({remembering_rule:'Remember work decisions only.'});
 await act(b,'save',{remembering:{enabled:false,rule:'Remember work decisions only.'},grants:[]});expect(stagedHeads(root)).toHaveLength(0);expect(admitStaged(root,['work'])[0]?.ok).toBe(false);
 expect(readableIntegrationAccounts(root,'email',{kind:'pilot'})).toEqual([a]);
 await act(a,'disconnect');expect(readableIntegrationAccounts(root,'email',{kind:'pilot'})).toEqual([]);expect(accountPolicy(root,'email',b).remembering.rule).toBe('Remember work decisions only.');
});
test('changing one password invalidates only that account, and a late connection check cannot undo disconnect',async()=>{
 const {root,accounts}=fixture();for(const account of ['personal@example.com','work@example.com'])await accounts.update({name:'email',account,action:'connect'});
 writeFileSync(join(root,'.env'),'BIGBRAIN_IMAP_PASSWORD__PERSONAL_EXAMPLE_COM=changed\nBIGBRAIN_IMAP_PASSWORD__WORK_EXAMPLE_COM=two\n');
 expect(accountPolicy(root,'email','personal@example.com').connected).toBe(false);expect(accountPolicy(root,'email','work@example.com').connected).toBe(true);
 const racing=new IntegrationAccounts(root,{email:async()=>{await accounts.update({name:'email',account:'personal@example.com',action:'disconnect'});}});
 await expect(racing.update({name:'email',account:'personal@example.com',action:'connect'})).rejects.toThrow('changed');expect(accountPolicy(root,'email','personal@example.com').connected).toBe(false);
});
test('additional accounts have independent keys and never inherit legacy defaults',async()=>{
 const {root}=fixture();const keys:string[]=[];const accounts=new IntegrationAccounts(root,{tracks:async key=>{keys.push(key);}});
 const first=await accounts.update({name:'that-tracks',action:'add',label:'Work meetings',key:'work-key'});
 const work=first.accounts.find(a=>a.label==='Work meetings')!;
 const second=await accounts.update({name:'that-tracks',action:'add',label:'Personal meetings',key:'personal-key'});
 const personal=second.accounts.find(a=>a.label==='Personal meetings')!;
 expect(work.connected).toBe(false);expect(work.remembering.enabled).toBe(false);expect(work.grants).toEqual([]);
 for(const account of [work.account,personal.account])await accounts.update({name:'that-tracks',account,action:'connect'});
 expect(keys).toEqual(['work-key','personal-key']);
 await accounts.update({name:'that-tracks',account:work.account,action:'save',remembering:{enabled:true,rule:'Remember work decisions.'},grants:[]});
 expect(integrationActive(root,'that-tracks',work.account)).toBe(true);expect(integrationActive(root,'that-tracks',personal.account)).toBe(false);
 await accounts.update({name:'that-tracks',account:personal.account,action:'credentials',key:'replacement'});
 expect(accountPolicy(root,'that-tracks',personal.account).connected).toBe(false);expect(accountPolicy(root,'that-tracks',work.account).connected).toBe(true);
 // Whatever was added can be removed; the built-in slot cannot.
 expect(accounts.list().accounts.filter(a=>a.name==='that-tracks').map(a=>[a.account===a.name?'built-in':'added',a.removable])).toEqual([['built-in',false],['added',true],['added',true]]);
 await expect(accounts.update({name:'that-tracks',account:'that-tracks',action:'remove'})).rejects.toThrow('Disconnect');
 const removed=await accounts.update({name:'that-tracks',account:personal.account,action:'remove'});
 expect(removed.accounts.map(a=>a.account)).not.toContain(personal.account);expect(removed.accounts.map(a=>a.account)).toContain(work.account);
 expect(readEnvValues(root)[`THAT_TRACKS_API_KEY__${personal.account.replaceAll('-','_').toUpperCase()}`]??'').toBe('');
 expect(readEnvValues(root)[`THAT_TRACKS_API_KEY__${work.account.replaceAll('-','_').toUpperCase()}`]).toBe('work-key');
 expect(accountPolicy(root,'that-tracks',work.account).remembering.rule).toBe('Remember work decisions.');
 await expect(accounts.update({name:'that-tracks',account:personal.account,action:'connect'})).rejects.toThrow('configured account');
 expect(JSON.stringify(accounts.list())).not.toContain('work-key');
 await expect(accounts.update({name:'that-tracks',account:work.account,action:'grant',caller:'pilot',access:'read-write'})).rejects.toThrow('supported');
});
test('desktop scheduling follows per-account remembering even without a legacy source declaration',async()=>{
 const {root}=fixture(),accounts=new IntegrationAccounts(root,{tracks:async()=>{}});
 const added=await accounts.update({name:'that-tracks',action:'add',label:'Meetings',key:'synthetic'}),account=added.accounts.find(a=>a.label==='Meetings')!.account;
 const plan=async()=>{const child=Bun.spawn([process.execPath,'bin/desktop.ts','--dry-run'],{env:{...process.env,BIGBRAIN_VAULT:root,BIGBRAIN_DEV:'1',HOME:root},stdout:'pipe',stderr:'pipe'});const output=await new Response(child.stdout).text();expect(await child.exited).toBe(0);return output;};
 await accounts.update({name:'that-tracks',account,action:'connect'});expect(await plan()).not.toContain('integrations/that-tracks/run.ts');
 await accounts.update({name:'that-tracks',account,action:'save',remembering:{enabled:true,rule:'Remember decisions.'},grants:[]});expect(await plan()).toContain('integrations/that-tracks/run.ts');
 await accounts.update({name:'that-tracks',account,action:'disconnect'});expect(await plan()).not.toContain('integrations/that-tracks/run.ts');
});

test('adding Granola opts in once; existing policies and custom rules survive re-add and reads',async()=>{
 const {root,accounts}=fixture();
 expect(accounts.list().library.find(i=>i.id==='granola')?.added).toBe(false);
 expect(accountPolicy(root,'granola','granola').remembering.enabled).toBe(false);
 await accounts.update({name:'granola',action:'install'});
 expect(accounts.list().library.find(i=>i.id==='granola')?.added).toBe(true);
 const added=accountPolicy(root,'granola','granola');
 expect(added.liveAccess).toBe(true);expect(added.remembering.enabled).toBe(true);expect(added.connected).toBe(false);
 const {writeAccountPolicy}=await import('../lib/integrationAccess');
 writeAccountPolicy(root,'granola','granola',{...added,liveAccess:false,remembering:{enabled:false,rule:'My existing rule'}});
 await accounts.update({name:'granola',action:'install'});
 expect(accountPolicy(root,'granola','granola')).toMatchObject({liveAccess:false,remembering:{enabled:false,rule:'My existing rule'}});
 expect(accounts.list().accounts.find(a=>a.name==='email')?.remembering.enabled).toBe(false);
 const result=await accounts.update({name:'granola',action:'add',label:'Work'});
 expect(result.accounts.find(a=>a.label==='Work')).toMatchObject({connected:false,liveAccess:true,remembering:{enabled:true}});
});
test('an inbox at imap.gmail.com from the earlier add form is listed under Gmail with IMAP access, refuses a duplicate add, reconnects, and can be removed',async()=>{
 const root=gitVault({files:{'vault.yaml':'integrations:\n  email:\n    inboxes:\n      - address: legacy@gmail.com\n        host: imap.gmail.com\n','.env':'BIGBRAIN_IMAP_PASSWORD__LEGACY_GMAIL_COM=old\n','.gitignore':'.env\n.spool/\n'}});roots.push(root);
 const probes:{address:string;host:string}[]=[];const accounts=new IntegrationAccounts(root,{email:async i=>{probes.push({address:i.address,host:i.host});}});
 expect(accounts.list().accounts.find(a=>a.account==='legacy@gmail.com')).toMatchObject({gmail:false,google:true,host:'imap.gmail.com',connected:false});
 expect(accounts.list().library.find(i=>i.id==='email')?.added).toBe(true);
 await expect(accounts.update({name:'email',action:'add',address:'Legacy@gmail.com',password:'abcdefghijklmnop'})).rejects.toThrow('already exists');
 expect(probes).toEqual([]);expect(readEnvValues(root).BIGBRAIN_IMAP_PASSWORD__LEGACY_GMAIL_COM).toBe('old');
 await accounts.update({name:'email',account:'legacy@gmail.com',action:'credentials',key:'abcd efgh ijkl mnop'});
 expect(probes).toEqual([{address:'legacy@gmail.com',host:'imap.gmail.com'}]);
 expect(accountPolicy(root,'email','legacy@gmail.com').connected).toBe(true);expect(readEnvValues(root).BIGBRAIN_IMAP_PASSWORD__LEGACY_GMAIL_COM).toBe('abcdefghijklmnop');
 expect(accounts.list().accounts.find(a=>a.account==='legacy@gmail.com')?.capabilities.write).toBeTruthy();
 const after=await accounts.update({name:'email',account:'legacy@gmail.com',action:'remove'});
 expect(after.accounts.some(a=>a.name==='email')).toBe(false);expect(after.library.find(i=>i.id==='email')?.added).toBe(false);
 expect(readFileSync(join(root,'vault.yaml'),'utf8')).not.toContain('legacy@gmail.com');
 expect(readEnvValues(root).BIGBRAIN_IMAP_PASSWORD__LEGACY_GMAIL_COM??'').toBe('');
 expect(readdirSync(join(root,'.spool','integration-accounts','email'))).toEqual([]);
 await expect(accounts.update({name:'email',account:'legacy@gmail.com',action:'remove'})).rejects.toThrow('configured account');
});
test('a plain IMAP inbox reconnects with its own password against its own host',async()=>{
 const {root}=fixture();const probes:unknown[]=[];const api=new IntegrationAccounts(root,{email:async i=>{probes.push({address:i.address,host:i.host,port:i.port});}});
 await expect(api.update({name:'email',account:'work@example.com',action:'credentials',key:'   '})).rejects.toThrow('password');
 await api.update({name:'email',account:'work@example.com',action:'credentials',key:'new secret'});
 expect(probes).toEqual([{address:'work@example.com',host:'imap.example.com',port:993}]);
 expect(readEnvValues(root).BIGBRAIN_IMAP_PASSWORD__WORK_EXAMPLE_COM).toBe('new secret');
 expect(api.list().accounts.find(a=>a.account==='work@example.com')).toMatchObject({gmail:false,google:false,host:'imap.example.com',connected:true});
});
