import {test,expect} from 'bun:test';
import {mkdirSync,rmSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {nativeVault} from './support/vault';
import {sha256hex} from '../lib/hash';
import {fakeGranola as fake} from './support/granolaFake';
import {startGranolaSignIn,granolaSignInStatus,cancelGranolaSignIn,granolaConnection,disconnectGranola,withGranola,mcpData} from '../lib/granolaMcp';

test('Granola OAuth binds state, isolates two accounts, persists privately and disconnects',async()=>{
 const root=nativeVault(),f=fake();
 try{
  for(const account of ['work','personal']){
   let committed=false;
   const status=await startGranolaSignIn(root,account,()=>{committed=true;},{endpoint:f.endpoint});
   expect(status.phase).toBe('browser');expect(granolaConnection(root,account)).toBeUndefined();
   const auth=new URL(status.url!),redirect=auth.searchParams.get('redirect_uri')!;
   expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
   expect((await fetch(redirect+'?code='+account+'&state=wrong')).status).toBe(400);
   expect(committed).toBe(false);
   const response=await fetch(redirect+'?code='+account+'&state='+auth.searchParams.get('state'));
   expect(await response.text()).toContain('Granola connected');expect(committed).toBe(true);
   expect(granolaSignInStatus(root,account)?.phase).toBe('connected');
   const info=await withGranola(root,account,async c=>mcpData(await c.callTool({name:'get_account_info',arguments:{}}) as any),{endpoint:f.endpoint});
   expect(info).toEqual({email:account+'@example.test',workspace:'fixture'});
  }
  expect(f.registered()).toBe(2);
  for(const file of readdirSync(join(root,'.spool/source-mcp/granola')))expect(statSync(join(root,'.spool/source-mcp/granola',file)).mode&0o777).toBe(0o600);
  disconnectGranola(root,'work');expect(granolaConnection(root,'work')).toBeUndefined();expect(granolaConnection(root,'personal')).toBeDefined();
  await expect(withGranola(root,'work',async()=>null,{endpoint:f.endpoint})).rejects.toThrow('Connect Granola');
 }finally{cancelGranolaSignIn(root,'work');cancelGranolaSignIn(root,'personal');f.server.stop(true);rmSync(root,{recursive:true,force:true});}
});
test('cancelled OAuth callback cannot reconnect an account',async()=>{
 const root=nativeVault(),f=fake();try{
  const s=await startGranolaSignIn(root,'a',()=>{throw Error('must not commit');},{endpoint:f.endpoint});
  expect(s.url).toBeDefined();cancelGranolaSignIn(root,'a');
  expect(granolaConnection(root,'a')).toBeUndefined();expect(granolaSignInStatus(root,'a')?.phase).toBe('cancelled');
 }finally{f.server.stop(true);rmSync(root,{recursive:true,force:true});}
});

import {IntegrationAccounts} from '../lib/integrationAccounts';
import {accountPolicy,writeAccountPolicy,readableIntegrationAccounts} from '../lib/integrationAccess';
import {pollGranolaMcp,granolaMeetingList} from '../lib/granolaMcpPoll';
import {integrationToolCall} from '../lib/integrationTools';
import {headFiles} from '../lib/stageStorage';
import {mintToken,revokeToken} from '../lib/auth';
const meetingId='11111111-1111-4111-8111-111111111111';
const result=(text:string)=>({content:[{type:'text' as const,text}]});
async function connect(service:IntegrationAccounts,root:string){
 writeFileSync(join(root,'vault.yaml'),'integrations: {}\n');
 await service.update({name:'granola',account:'granola',action:'connect'});
 const auth=new URL(granolaSignInStatus(root,'granola')!.url!);
 const response=await fetch(auth.searchParams.get('redirect_uri')+'?code=work&state='+auth.searchParams.get('state'));
 expect(response.status).toBe(200);
}
test('Granola live access applies to every authenticated client and never stages; revocation withholds results',async()=>{
 const root=nativeVault();let beforeRead=()=>{};
 const f=fake(()=>{beforeRead();return result('current meeting data');});
 const service=new IntegrationAccounts(root,{granolaSignIn:(r,a,cb)=>startGranolaSignIn(r,a,cb,{endpoint:f.endpoint})});
 try{
  await connect(service,root);
  const save=(liveAccess:boolean)=>service.update({name:'granola',account:'granola',action:'save',liveAccess});
  await save(true);
  const store=join(root,'tokens.json'),a=mintToken(store,root,'Independent client',['vault:read'],{kind:'agent'}),b=mintToken(store,root,'Orchestrated client',['vault:read'],{kind:'agent'});
  const callers=[{kind:'pilot' as const},...[a,b].map(c=>({kind:'mcp' as const,token:c.token,storePath:store}))];
  const read=(caller:typeof callers[number])=>integrationToolCall(root,caller,'granola_read',{account:'granola',tool:'list_meetings',arguments:{}},{granola:{endpoint:f.endpoint}});
  for(const caller of callers){expect(readableIntegrationAccounts(root,'granola',caller)).toEqual(['granola']);expect(await read(caller)).toMatchObject({provenance:{remembered:false}});}
  expect(headFiles(root)).toHaveLength(0);
  beforeRead=()=>revokeToken(store,a.record.id);
  await expect(read(callers[1]!)).rejects.toThrow();
  beforeRead=()=>{};await save(false);
  for(const caller of [callers[0]!,callers[2]!])await expect(read(caller)).rejects.toThrow('not available');
  expect(headFiles(root)).toHaveLength(0);
 }finally{disconnectGranola(root,'granola');f.server.stop(true);rmSync(root,{recursive:true,force:true});}
});
test('a connected Granola stages independently of live access, deduplicates, captures changes and stops when disconnected',async()=>{
 const root=nativeVault();let revision=1,broken=false,disable=false;
 let service:IntegrationAccounts;
 const f=fake(async name=>{
  if(disable)setConnected(false);
  if(name==='list_meetings')return result(broken?'<meetings_data count="1">':`<meetings_data count="1"><meeting id="${meetingId}" title="Decision &amp; review" date="2026-09-24T12:00:00Z" url="https://notes.granola.ai/d/${meetingId}"></meeting></meetings_data>`);
  if(name==='get_meetings')return result(`<meetings_data count="1"><meeting id="${meetingId}"><summary>Decision ${revision}</summary></meeting></meetings_data>`);
  return result(JSON.stringify({id:meetingId,transcript:`Microphone: Keep this speaker label. Revision ${revision}`,recording_context:{microphone_sharing:'unknown'}}));
 });
 service=new IntegrationAccounts(root,{granolaSignIn:(r,a,cb)=>startGranolaSignIn(r,a,cb,{endpoint:f.endpoint})});
 const setConnected=(connected:boolean)=>writeAccountPolicy(root,'granola','granola',{...accountPolicy(root,'granola','granola'),connected});
 const run=<T>(fn:Parameters<typeof withGranola<T>>[2])=>withGranola(root,'granola',fn,{endpoint:f.endpoint});
 const poll=(since?:string)=>pollGranolaMcp(root,'granola',{now:new Date('2026-09-24T13:00:00Z'),since,run});
 try{
  await connect(service,root);
  expect(await poll()).toEqual({arrivals:0}); // No implicit historical import.
  expect(await poll('2026-09-24T00:00:00Z')).toEqual({arrivals:1});
  expect(await poll()).toEqual({arrivals:0});expect(headFiles(root)).toHaveLength(1);
  revision++;expect(await poll()).toEqual({arrivals:1});expect(headFiles(root)).toHaveLength(2);
  broken=true;await expect(poll()).rejects.toThrow('format changed');broken=false;
  expect(await poll()).toEqual({arrivals:0});
  revision++;disable=true;await expect(poll()).rejects.toThrow('not connected');expect(headFiles(root)).toHaveLength(2);
  disable=false;setConnected(true);
  expect(headFiles(root)).toHaveLength(2); // Material pending while disconnected was retained, not admitted or discarded.
 }finally{disconnectGranola(root,'granola');f.server.stop(true);rmSync(root,{recursive:true,force:true});}
});
test('a reconnect resumes from the last poll: a meeting held while it was down still arrives',async()=>{
 const root=nativeVault();
 const f=fake(async name=>{
  if(name==='list_meetings')return result(`<meetings_data count="1"><meeting id="${meetingId}" title="Orrery review" date="2026-09-24T12:00:00Z" url="https://notes.granola.ai/d/${meetingId}"></meeting></meetings_data>`);
  if(name==='get_meetings')return result(`<meetings_data count="1"><meeting id="${meetingId}"><summary>Kit signs off</summary></meeting></meetings_data>`);
  return result(JSON.stringify({id:meetingId,transcript:'Microphone: The orrery is repaired.',recording_context:{microphone_sharing:'unknown'}}));
 });
 const service=new IntegrationAccounts(root,{granolaSignIn:(r,a,cb)=>startGranolaSignIn(r,a,cb,{endpoint:f.endpoint})});
 const run=<T>(fn:Parameters<typeof withGranola<T>>[2])=>withGranola(root,'granola',fn,{endpoint:f.endpoint});
 try{
  await connect(service,root);
  // the previous connection last polled at 11:00; this one is new
  const file=join(root,'.spool','integration-cursors','granola-mcp-'+sha256hex('granola').slice(0,24)+'.json');
  mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,JSON.stringify({version:1,generation:'an-earlier-connection',startedAt:'2026-09-20T00:00:00Z',lastPolledAt:'2026-09-24T11:00:00Z',seen:{}}));
  expect(await pollGranolaMcp(root,'granola',{now:new Date('2026-09-24T13:00:00Z'),run})).toEqual({arrivals:1});
 }finally{disconnectGranola(root,'granola');f.server.stop(true);rmSync(root,{recursive:true,force:true});}
});
test('"Import earlier meetings" brings in history a window at a time, once per request',async()=>{
 const root=nativeVault();
 const ids=['22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333',meetingId];
 const dates=['2026-07-10T15:00:00Z','2026-08-05T09:00:00Z','2026-09-24T12:00:00Z'];
 const f=fake(async(name,args)=>{
  if(name==='list_meetings'){const hits=ids.flatMap((id,i)=>dates[i]!.slice(0,10)>=args.custom_start&&dates[i]!.slice(0,10)<=args.custom_end?[`<meeting id="${id}" title="Meeting ${i}" date="${dates[i]}"></meeting>`]:[]);return result(`<meetings_data count="${hits.length}">${hits.join('')}</meetings_data>`);}
  if(name==='get_meetings')return result(`<meetings_data count="1"><meeting id="${args.meeting_ids[0]}"><summary>Notes</summary></meeting></meetings_data>`);
  return result(JSON.stringify({id:args.meeting_id,transcript:'Microphone: A verbatim turn.'}));
 });
 const service=new IntegrationAccounts(root,{granolaSignIn:(r,a,cb)=>startGranolaSignIn(r,a,cb,{endpoint:f.endpoint})});
 const run=<T>(fn:Parameters<typeof withGranola<T>>[2])=>withGranola(root,'granola',fn,{endpoint:f.endpoint});
 const poll=()=>pollGranolaMcp(root,'granola',{now:new Date('2026-09-24T13:00:00Z'),run});
 const lists=()=>f.calls.filter(c=>c==='list_meetings').length;
 try{
  await connect(service,root);
  expect(await poll()).toEqual({arrivals:0});
  await service.update({name:'granola',account:'granola',action:'save',liveAccess:false,backfillSince:'2026-07-01'});
  expect(accountPolicy(root,'granola','granola').granola?.backfill?.since).toBe('2026-07-01T00:00:00.000Z');
  const before=lists();
  expect(await poll()).toEqual({arrivals:3});
  expect(lists()-before).toBeGreaterThan(4); // ~12 weeks in 14-day windows
  expect(headFiles(root)).toHaveLength(3);
  const after=lists();
  expect(await poll()).toEqual({arrivals:0}); // honored once; back to the usual window
  expect(lists()-after).toBe(1);
 }finally{disconnectGranola(root,'granola');f.server.stop(true);rmSync(root,{recursive:true,force:true});}
});
test('Granola rejects incomplete lists',()=>{
 expect(()=>granolaMeetingList(result('<meetings_data count="1"></meetings_data>'))).toThrow('incomplete');
});

test('cancellation during token exchange cannot publish a connected account',async()=>{
 const root=nativeVault();let entered!:()=>void,finish!:()=>void;
 const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>finish=r);
 const f=fake(undefined,async()=>{entered();await gate;});let committed=false;
 try{
  const status=await startGranolaSignIn(root,'granola',()=>{committed=true;},{endpoint:f.endpoint});
  const auth=new URL(status.url!);
  const callback=fetch(auth.searchParams.get('redirect_uri')+'?code=work&state='+auth.searchParams.get('state'));
  await started;cancelGranolaSignIn(root,'granola');finish();
  expect((await callback).status).toBe(400);expect(committed).toBe(false);expect(granolaConnection(root,'granola')).toBeUndefined();
 }finally{finish();f.server.stop(true);rmSync(root,{recursive:true,force:true});}
});

test('explicit library addition keeps its enabled defaults through first OAuth sign-in',async()=>{
 const root=nativeVault({files:{'vault.yaml':'integrations: {}\n'}}),f=fake(()=>result('data'));
 const service=new IntegrationAccounts(root,{granolaSignIn:(r,a,cb)=>startGranolaSignIn(r,a,cb,{endpoint:f.endpoint})});
 try{
  await service.update({name:'granola',action:'install'});
  await connect(service,root);
  expect(service.list().accounts.find(a=>a.name==='granola')).toMatchObject({connected:true,liveAccess:true});
 }finally{disconnectGranola(root,'granola');f.server.stop(true);rmSync(root,{recursive:true,force:true});}
});
