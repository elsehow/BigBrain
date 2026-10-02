import {afterEach,expect,test} from 'bun:test';
import {appendFileSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {nativeVault} from './support/vault';
import {fakeIntegrationActivation} from './support/integrationActivation';
import {granolaMcpContent,pollGranolaMcp} from '../lib/granolaMcpPoll';
import {stageGranolaContent} from '../lib/granolaStage';
import {granolaRevision,receiveStagedGranola} from '../lib/granolaRevision';
import {admitStaged,passStaged,stagedItems,stageDir} from '../lib/stage';
import {stage} from '../lib/stageStorage';
import {readSourceInsertionLog,insertionEventRel} from '../lib/insertionLog';
import {receive} from '../lib/intake';
import {sha256hex} from '../lib/hash';
import {writeAtomic} from '../lib/fsx';
import {accountFingerprint,accountPolicy,writeAccountPolicy} from '../lib/integrationAccess';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function vault(){const root=nativeVault({files:{"vault.yaml":"integrations: {}\n"}});roots.push(root);fakeIntegrationActivation(root,'granola');return root;}
const meeting={id:'11111111-1111-4111-8111-111111111111',title:'Synthetic decision',date:'2026-09-24T12:00:00Z',url:'https://example.test/meeting'};
const result=(text:string)=>({content:[{type:'text' as const,text}]});
function content(version:string,account='granola',identity:unknown={workspace:'fixture'}){
 return granolaMcpContent(account,identity,meeting,result(`<meeting id="${meeting.id}"><summary>Discarded</summary></meeting>`),result(JSON.stringify({id:meeting.id,transcript:`Transcript ${version}`})));
}
function pending(root:string,version:string){return stagedItems(root,'granola').find(i=>i.content.includes(`Transcript ${version}`))!;}
const observe=(root:string,v:string)=>stageGranolaContent(root,'granola',content(v));
const resetCaches=(root:string)=>{rmSync(join(root,'.state'),{recursive:true,force:true});rmSync(join(root,'.spool/integration-cursors'),{recursive:true,force:true});};

test('pending, admitted and passed revisions survive cursor/projection loss without another arrival',async()=>{
 const root=vault();
 expect(await observe(root,'A')).toBe(true);resetCaches(root);expect(await observe(root,'A')).toBe(false);
 expect(readSourceInsertionLog(root)).toHaveLength(0); // Reading/staging never grants admission.
 const a=pending(root,'A');expect(admitStaged(root,[a.id])[0]?.ok).toBe(true);
 const first=readSourceInsertionLog(root)[0]!,bytes=readFileSync(join(root,insertionEventRel(first)),'utf8');
 resetCaches(root);expect(await observe(root,'A')).toBe(false);expect(stagedItems(root,'granola')).toHaveLength(0);
 expect(await observe(root,'B')).toBe(true);const b=pending(root,'B');expect(passStaged(root,[b.id],'Not relevant')[0]?.ok).toBe(true);
 resetCaches(root);expect(await observe(root,'B')).toBe(false);expect(stagedItems(root,'granola')).toHaveLength(0);
 expect(readSourceInsertionLog(root)).toHaveLength(1);
 expect(readFileSync(join(root,insertionEventRel(first)),'utf8')).toBe(bytes);
 expect(await observe(root,'C')).toBe(true);expect(granolaRevision(pending(root,'C').content).seq).toBe(3);
});

test('changed evidence shares source identity, supersedes only at admission, and known old content cannot roll back',async()=>{
 const root=vault();await observe(root,'A');const a=admitStaged(root,[pending(root,'A').id])[0]!;
 await observe(root,'B');expect(readSourceInsertionLog(root)).toHaveLength(1);
 const b=admitStaged(root,[pending(root,'B').id])[0]!;
 expect(b.ok).toBe(true);expect(b.source_id).toBe(a.source_id);
 expect(readSourceInsertionLog(root).find(e=>e.id===b.insertion_id)?.envelope.supersedes).toBe(a.insertion_id);
 resetCaches(root);expect(await observe(root,'A')).toBe(false);expect(await observe(root,'B')).toBe(false);
 expect(readSourceInsertionLog(root)).toHaveLength(2);
});

test('admitting pending versions in reverse order refuses the older observation without deleting it',async()=>{
 const root=vault();await observe(root,'A');await observe(root,'B');const a=pending(root,'A'),b=pending(root,'B');
 expect(admitStaged(root,[b.id])[0]?.ok).toBe(true);
 expect(admitStaged(root,[a.id])[0]).toMatchObject({ok:false,error:expect.stringContaining('later-observed')});
 expect(pending(root,'A')).toBeDefined();expect(passStaged(root,[a.id],'Already superseded')[0]?.ok).toBe(true);
 resetCaches(root);expect(await observe(root,'A')).toBe(false);expect(readSourceInsertionLog(root)).toHaveLength(1);
});

test('interruption between append and pending cleanup returns the same insertion on retry',async()=>{
 const root=vault();await observe(root,'A');const a=pending(root,'A');
 const receipt=receiveStagedGranola(root,a.content);resetCaches(root);
 expect(admitStaged(root,[a.id])[0]).toMatchObject({ok:true,insertion_id:receipt.insertionId});
 expect(readSourceInsertionLog(root)).toHaveLength(1);expect(stagedItems(root,'granola')).toHaveLength(0);
});

test('legacy MCP insertions keep their source IDs and bytes; legacy pending and pass decisions recover',async()=>{
 const root=vault(),raw=content('A'),old=receive({root,content:raw});
 const bytes=readFileSync(join(root,old.path),'utf8');resetCaches(root);
 expect(await observe(root,'A')).toBe(false);await observe(root,'B');
 const next=admitStaged(root,[pending(root,'B').id])[0]!;
 expect(next).toMatchObject({ok:true,source_id:old.id});
 expect(readSourceInsertionLog(root).find(e=>e.id===next.insertion_id)?.envelope.supersedes).toBe(old.insertionId);
 expect(readFileSync(join(root,old.path),'utf8')).toBe(bytes);
 const legacy=content('C'),id='granola-'+sha256hex('granola\n'+legacy).slice(0,32);
 stage(root,{id,source:'granola',account:'granola',at:meeting.date,line:meeting.title,scopes:{},name:id+'.md',content:legacy});
 expect(await observe(root,'C')).toBe(false);
 // A pre-upgrade pending observation has no reliable sequence: don't claim it is newest.
 expect(admitStaged(root,[id])[0]?.ok).toBe(false);
 const passed=content('D'),passedId='granola-'+sha256hex('granola\n'+passed).slice(0,32);
 appendFileSync(join(stageDir(root),'passed.jsonl'),JSON.stringify({id:passedId,source:'granola',reason:'Earlier decision'})+'\n');
 resetCaches(root);expect(await observe(root,'D')).toBe(false);
});

test('two accounts and changed upstream identities cannot deduplicate or supersede each other',async()=>{
 const root=vault(),account='account-2222222222222222';
 writeAtomic(join(root,'.spool/integration-accounts/granola/accounts.json'),JSON.stringify([{id:account,label:'Other'}]));
 writeAtomic(join(root,'.spool/source-mcp/granola',sha256hex(account)+'.json'),JSON.stringify({generation:'other',connected:true,tokens:{access_token:'synthetic'},identity:{workspace:'fixture'}}));
 writeAccountPolicy(root,'granola',account,{...accountPolicy(root,'granola','granola'),fingerprint:accountFingerprint(root,'granola',account)});
 await observe(root,'A');admitStaged(root,[pending(root,'A').id]);
 expect(await stageGranolaContent(root,account,content('A',account))).toBe(true);
 const other=stagedItems(root,'granola').find(i=>i.account===account)!;
 expect(admitStaged(root,[other.id])[0]?.ok).toBe(true);
 expect(await stageGranolaContent(root,'granola',content('A','granola',{workspace:'changed'}))).toBe(true);
 admitStaged(root,stagedItems(root,'granola').map(i=>i.id));
 const log=readSourceInsertionLog(root);expect(log).toHaveLength(3);expect(new Set(log.map(e=>e.source_id)).size).toBe(3);
 expect(log.every(e=>!e.envelope.supersedes)).toBe(true);
});

test('disabled remembering preserves pending material and prevents staging, admission and passing',async()=>{
 const root=vault();await observe(root,'A');const a=pending(root,'A'),p=accountPolicy(root,'granola','granola');
 writeAccountPolicy(root,'granola','granola',{...p,remembering:{...p.remembering,enabled:false}});
 await expect(observe(root,'B')).rejects.toThrow('remembering is off');
 expect(admitStaged(root,[a.id])[0]?.ok).toBe(false);expect(passStaged(root,[a.id],'No')[0]?.ok).toBe(false);
 expect(pending(root,'A')).toBeDefined();expect(readSourceInsertionLog(root)).toHaveLength(0);
});

test('corrupt pass audit fails closed instead of silently forgetting a decision',async()=>{
 const root=vault();await observe(root,'A');passStaged(root,[pending(root,'A').id],'No');
 appendFileSync(join(stageDir(root),'passed.jsonl'),'{torn');resetCaches(root);
 await expect(observe(root,'A')).rejects.toThrow();expect(stagedItems(root,'granola')).toHaveLength(0);
});

test('the MCP poller recovers admitted and passed decisions after cursor loss and same-identity reconnect',async()=>{
 const root=vault();let version='A';
 const run:NonNullable<Parameters<typeof pollGranolaMcp>[2]>['run']=async fn=>fn({callTool:async({name}:{name:string})=>name==='list_meetings'
  ?result(`<meetings_data count="1"><meeting id="${meeting.id}" title="${meeting.title}" date="${meeting.date}" url="${meeting.url}"></meeting></meetings_data>`)
  :name==='get_meeting_transcript'?result(JSON.stringify({id:meeting.id,transcript:`Transcript ${version}`})):result(`<meeting id="${meeting.id}"><summary>Discarded</summary></meeting>`)} as Client,
  ['list_meetings','get_meetings','get_meeting_transcript'].map(name=>({name,inputSchema:{type:'object' as const}})));
 const poll=()=>pollGranolaMcp(root,'granola',{now:new Date('2026-09-25T00:00:00Z'),since:'2026-09-24T00:00:00Z',run});
 expect(await poll()).toEqual({arrivals:1});admitStaged(root,[pending(root,'A').id]);
 resetCaches(root);expect(await poll()).toEqual({arrivals:0});
 version='B';expect(await poll()).toEqual({arrivals:1});passStaged(root,[pending(root,'B').id],'No');
 const file=join(root,'.spool/source-mcp/granola',sha256hex('granola')+'.json');
 const credential=JSON.parse(readFileSync(file,'utf8'));credential.generation='reconnected';writeFileSync(file,JSON.stringify(credential));
 writeAccountPolicy(root,'granola','granola',{...accountPolicy(root,'granola','granola'),connected:true,fingerprint:accountFingerprint(root,'granola','granola')});
 resetCaches(root);expect(await poll()).toEqual({arrivals:0});
 expect(readSourceInsertionLog(root)).toHaveLength(1);expect(stagedItems(root,'granola')).toHaveLength(0);
});

test('concurrent admission of one revision has one immutable insertion and one receipt',async()=>{
 const root=vault();await observe(root,'A');const item=pending(root,'A');
 const payload=join(root,'candidate.md'),script=join(root,'admit.ts');writeFileSync(payload,item.content);
 writeFileSync(script,`import {readFileSync} from 'node:fs';\nimport {receiveStagedGranola} from ${JSON.stringify(join(import.meta.dir,'../lib/granolaRevision.ts'))};\nconsole.log(JSON.stringify(receiveStagedGranola(process.argv[2]!,readFileSync(process.argv[3]!,'utf8'))));\n`);
 const run=async()=>{
  const p=Bun.spawn([process.execPath,script,root,payload],{stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  expect(err).toBe('');expect(code).toBe(0);return JSON.parse(out);
 };
 const [a,b]=await Promise.all([run(),run()]);expect(a.id).toBe(b.id);expect(a.insertionId).toBe(b.insertionId);expect(readSourceInsertionLog(root)).toHaveLength(1);
});

test('transcript contract copies provider attendees and exact speech, excluding vendor summaries',()=>{
 const speech='Microphone: Um, the raw wor—word.\nSystem: Okay.';
 const transcript=result(JSON.stringify({id:meeting.id,transcript:speech}));
 const notes=(summary:string)=>result(`<meeting id="${meeting.id}"><known_participants>Ada &amp; Briar</known_participants><summary>${summary}</summary></meeting>`);
 const a=granolaMcpContent('granola',{},meeting,notes('Invented summary A'),transcript);
 expect(a).toContain('Attendees: Ada & Briar');expect(a).toContain(speech);expect(a).not.toContain('Invented summary');
 expect(granolaMcpContent('granola',{},meeting,notes('Edited summary B'),transcript)).toBe(a);
 expect(()=>granolaMcpContent('granola',{},meeting,notes('A'))).toThrow('transcript access');
 expect(()=>granolaMcpContent('granola',{},meeting,notes('A'),result(JSON.stringify({id:meeting.id,transcript:''})))).toThrow('unavailable');
});
