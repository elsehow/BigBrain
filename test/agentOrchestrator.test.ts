import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentOrchestrator, type AgentSessionReport } from "../lib/agentOrchestrator";
import { Projects } from "../lib/worker/projects";
import { WorkHistory } from "../lib/workHistory";
import { fakePi, type ModelAnswer } from "./support/pi";
import { gitVault, mdVault, nativeVault } from "./support/vault";
import { PilotChats } from "./support/pilotSession";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
function dir(git = false) { const p = realpathSync(git ? gitVault({files:{'hello.txt':'Original'}}) : mdVault({files:{'hello.txt':'Original'}})); cleanups.push(()=>rmSync(p,{recursive:true,force:true})); return p; }
function fixture(steps: ModelAnswer[] = [{ result: 'Done' }]) {
  const root = realpathSync(nativeVault({files:{'.env':'BIGBRAIN_PILOT_ENABLED=true\n'}})); cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
  let requests = 0; const agents = new AgentOrchestrator(root,{loadPi:fakePi(()=>{requests++;return steps.shift() ?? {result:'Done'};})}); cleanups.push(()=>agents.close());
  const reports: AgentSessionReport[] = []; agents.setReporter(r=>reports.push(r));
  return {root,agents,reports,requests:()=>requests};
}
const call = (name: string, args: Record<string, unknown>): ModelAnswer => ({content:[{type:'toolCall',id:crypto.randomUUID(),name,arguments:args}]});
async function until(fn:()=>boolean) { for(let i=0;i<400;i++){if(fn())return;await Bun.sleep(10);} throw Error('Timed out'); }
const launch=(agents:AgentOrchestrator,args:Record<string,unknown>={},pilot='pilot')=>agents.launch(pilot,'message',{title:'Demo task',task:'Update hello.txt and verify',context:'Synthetic evidence',...args},[]);
const authorize=(projects:Projects,path:string,mode:'read'|'work'='work')=>projects.save({label:'Example project',path,mode,references:[],domains:[],accounts:[]});

test('new projects wait for a user decision; Pilot and stale requests cannot grant access; remembered scope survives reload',async()=>{
  const f=fixture(), project=dir(), job=launch(f.agents,{cwd:project,mode:'work'});
  expect(job.status).toBe('needs-input');expect(f.requests()).toBe(0);
  const request=job.worker.request!;
  expect(()=>f.agents.answer('pilot',job.id,request.id,'Approved',[])).toThrow('context');
  expect(()=>f.agents.approve(job.id,'stale',true,true)).toThrow('no longer');
  f.agents.approve(job.id,request.id,true,true); await until(()=>job.status==='idle');
  expect(new Projects(f.root).at(project)?.mode).toBe('work');expect(f.requests()).toBe(1);
  expect(()=>f.agents.approve(job.id,request.id,true,true)).toThrow('no longer');
  const next=launch(f.agents,{cwd:project,mode:'work'}); await until(()=>next.status==='idle');expect(f.requests()).toBe(2);
});

test('Pi edits and tests in an independent Git checkout without changing the source project',async()=>{
  const project=dir(true), f=fixture([call('write',{path:'hello.txt',content:'Updated'}),call('bash',{command:'test "$(cat hello.txt)" = Updated'}),{result:'Verified change'}]);
  Bun.spawnSync(['/usr/bin/git','-C',project,'remote','add','origin','https://example.com/team/atlas.git']);
  authorize(f.agents.projects,project);const job=launch(f.agents,{cwd:project});await until(()=>['idle','failed'].includes(job.status));
  expect(Bun.spawnSync(['/usr/bin/git','-C',job.cwd,'remote','get-url','origin']).stdout.toString().trim()).toBe('https://example.com/team/atlas.git');
  expect(job.error).toBeUndefined();expect(job.worker.isolation).toBe('checkout');expect(job.cwd).not.toBe(project);
  expect(readFileSync(join(project,'hello.txt'),'utf8')).toBe('Original');expect(readFileSync(join(job.cwd,'hello.txt'),'utf8')).toBe('Updated');
  expect(job.worker.operations.map(o=>o.status)).toEqual(['completed','completed']);expect(job.messages.at(-1)?.text).toBe('Verified change');expect(f.reports.at(-1)?.kind).toBe('completed');
},15_000);

test('access expansion waits in the app, replaces the executor, and task-only approval does not widen the project',async()=>{
  const project=dir(), f=fixture([call('request_access',{reason:'Need to edit',mode:'work',references:[],domains:[],accounts:[]}),call('write',{path:'hello.txt',content:'Approved edit'}),{result:'Saved'}]);
  const saved=authorize(f.agents.projects,project,'read'), job=launch(f.agents,{project:saved.id});
  await until(()=>job.worker.request?.kind==='access');expect(readFileSync(join(project,'hello.txt'),'utf8')).toBe('Original');
  f.agents.approve(job.id,job.worker.request!.id,true,false);await until(()=>['idle','failed'].includes(job.status));
  expect(job.error).toBeUndefined();expect(readFileSync(join(project,'hello.txt'),'utf8')).toBe('Approved edit');expect(f.agents.projects.get(saved.id)?.mode).toBe('read');
},15_000);

test('read mode denies commands and project writes even when the model calls them directly',async()=>{
  const project=dir(), f=fixture([call('bash',{command:'echo bad > injected'}),call('write',{path:'hello.txt',content:'Not authorized'}),{result:'Could not edit'}]);
  authorize(f.agents.projects,project,'read');const job=launch(f.agents,{cwd:project});await until(()=>['idle','failed'].includes(job.status));
  expect(existsSync(join(project,'injected'))).toBe(false);expect(readFileSync(join(project,'hello.txt'),'utf8')).toBe('Original');expect(job.worker.operations[0]?.status).toBe('uncertain');
});

test('context and user questions have separate answer authority and preserve ownership',async()=>{
  const f=fixture([call('ask_pilot',{question:'Which evidence?'}),call('ask_user',{question:'Which option?'}),{result:'Answered'}]),job=launch(f.agents);
  await until(()=>job.worker.request?.kind==='context');const first=job.worker.request!.id;
  expect(()=>f.agents.answer('another-pilot',job.id,first,'A',[])).toThrow('different Pilot');expect(()=>f.agents.userAnswer(job.id,first,'A')).toThrow('no longer');
  f.agents.answer('pilot',job.id,first,'Source A',['sources/example.md']);await until(()=>job.worker.request?.kind==='question');
  expect(()=>f.agents.answer('pilot',job.id,job.worker.request!.id,'A',[])).toThrow('context');
  f.agents.userAnswer(job.id,job.worker.request!.id,'Option A');await until(()=>job.status==='idle');expect(f.reports.filter(r=>r.kind==='question')).toHaveLength(1);
});

test('revocation stops pending work; widening saved policy never widens an existing task',async()=>{
  const f=fixture([call('ask_user',{question:'Continue?'}),{result:'Done'}]),project=dir(),p=authorize(f.agents.projects,project,'read'),job=launch(f.agents,{project:p.id});
  await until(()=>job.worker.request?.kind==='question');f.agents.projects.save({...p,mode:'work'});expect(job.worker.grant?.mode).toBe('read');
  f.agents.projects.remove(p.id);expect(job.status).toBe('interrupted');expect(job.worker.request).toBeUndefined();await Bun.sleep(30);await expect(f.agents.message(job.id,'Continue')).rejects.toThrow('revoked');
});

test('restart preserves public evidence and uncertain receipts without replaying execution',async()=>{
  const f=fixture(), project=dir(),job=launch(f.agents,{cwd:project,mode:'work'});const file=join(f.root,'.spool','workers',job.id+'.json');
  const saved=JSON.parse(readFileSync(file,'utf8'));saved.status='working';delete saved.worker.request;saved.worker.operations=[{id:'operation',tool:'write',status:'started',at:job.created}];saved.messages.push({id:'evidence',role:'agent',text:'Finding retained',at:job.created});writeFileSync(file,JSON.stringify(saved));
  let loaded=false;const restored=new AgentOrchestrator(f.root,{loadPi:async()=>{loaded=true;throw Error('Must not start');}});cleanups.push(()=>restored.close());
  const record=restored.get(job.id);expect(record.status).toBe('interrupted');expect(record.worker.operations[0]?.status).toBe('uncertain');expect(record.messages.at(-1)?.text).toBe('Finding retained');expect(loaded).toBe(false);
});

test('archiving a Pilot cancels its workers and prevents followups across restart',async()=>{
  const f=fixture([call('ask_user',{question:'Waiting'}),{result:'Done'}]);const chats=new PilotChats(f.root,{external:f.agents,graph:()=>[]});cleanups.push(()=>chats.close());
  const pilot=chats.create([]),job=launch(f.agents,{},pilot.id);await until(()=>job.worker.request?.kind==='question');await chats.stopTree(pilot.id);
  expect(job.worker.archivedAt).toBeTruthy();expect(job.status).toBe('interrupted');await expect(f.agents.message(job.id,'Continue')).rejects.toThrow();
  const restored=new AgentOrchestrator(f.root);cleanups.push(()=>restored.close());expect(restored.get(job.id).worker.archivedAt).toBeTruthy();await expect(restored.message(job.id,'Continue')).rejects.toThrow('archived');
});

test('retired native agents remain readable archives with no runtime reconstruction',()=>{
  const f=fixture(), id='work-'+'a'.repeat(32), at=new Date().toISOString();
  const {mkdirSync}=require('node:fs');mkdirSync(join(f.root,'.spool','external-agents'),{recursive:true});
  writeFileSync(join(f.root,'.spool','external-agents',id+'.json'),JSON.stringify({id,title:'Archived task',cwd:'/fixture',provider:'codex',status:'working',context:{},created:at,updated:at,messages:[{id:'answer',role:'agent',text:'Old evidence',at}],receipts:['receipt'],external:{adapter:'codex',connected:true,capabilities:{open:'attach',interrupt:true,followUp:true}}}));
  const history=new WorkHistory(f.root);expect(history.get(id).messages[0]?.text).toBe('Old evidence');expect(history.get(id).receipts).toEqual(['receipt']);expect(history.get(id).external?.archivedAt).toBe(at);expect(f.agents.has(id)).toBe(false);
});

// A nonzero exit can occur after a successful write; its receipt must not imply no effect.
test('a failed command retains an uncertain receipt and never replays on restart',async()=>{
  const f=fixture([call('bash',{command:'printf partial > result.txt; exit 1'}),{result:'Inspect the partial result'}]);
  const job=launch(f.agents);await until(()=>['idle','failed'].includes(job.status));
  expect(readFileSync(join(job.cwd,'result.txt'),'utf8')).toBe('partial');
  expect(job.worker.operations[0]?.status).toBe('uncertain');f.agents.close();
  let dispatched=false;const restored=new AgentOrchestrator(f.root,{loadPi:async()=>{dispatched=true;throw Error('No replay');}});cleanups.push(()=>restored.close());
  expect(restored.get(job.id).worker.operations[0]?.status).toBe('uncertain');expect(dispatched).toBe(false);
});

test('first-run environment setup preserves explicit model, reuses credentials, and revocation stops dependent workers',async()=>{
 const project=dir(),f=fixture([call('ask_user',{question:'Continue?'}),{result:'Done'}]);
 f.agents.projects.connect(project,{GH_TOKEN:'synthetic-token'});
 const selected={adapter:'pi' as const,provider:'anthropic',model:'claude-sonnet-5'};
 const job=launch(f.agents,{cwd:project,model:selected});expect(job.choice).toEqual(selected);
 const request=job.worker.request!;expect(f.reports.at(-1)).toMatchObject({kind:'access',key:`${job.id}:${request.id}`});
 f.agents.approve(job.id,request.id,true,true,{label:'Atlas environment',mode:'work',network:'public',credentials:['GH_TOKEN'],model:selected});
 await until(()=>job.worker.request?.kind==='question');
 const saved=f.agents.projects.at(project)!;expect(saved).toMatchObject({label:'Atlas environment',network:'public',credentials:['GH_TOKEN'],model:selected});
 expect(f.reports.some(r=>r.kind==='resolved' && r.key===`${job.id}:${request.id}`)).toBe(true);
 expect(JSON.stringify(job)).not.toContain('synthetic-token');
 f.agents.projects.connect(project,{GH_TOKEN:null});expect(job.status).toBe('interrupted');
});
test('access notifications survive restart once, remain pending through Pilot input, and resolve on decision',async()=>{
 const f=fixture(),chats=new PilotChats(f.root,{external:f.agents,graph:()=>[]});cleanups.push(()=>chats.close());
 const pilot=chats.create([]),project=dir(),job=launch(f.agents,{cwd:project},pilot.id);
 expect(chats.notifications()).toHaveLength(1);const notice=chats.notifications()[0]!;
 expect(notice.text).toContain(job.id);expect(notice.resolved).toBeFalsy();
 expect(await (chats as any).executeTool(chats.get(pilot.id),'resolve_notification',{id:notice.id},new AbortController().signal)).toMatchObject({error:expect.stringContaining('task card')});
 const {transitionPilot}=await import('../lib/pilotTransitions');
 const next=transitionPilot(chats.get(pilot.id),{kind:'input',input:{id:'message-test',text:'Checking',mode:'text'},message:'new-message',turn:'new-turn',at:new Date().toISOString(),queue:false});
 expect(next.state.notifications?.[0]?.resolved).toBeFalsy();
 expect(transitionPilot(next.state,{kind:'notification',id:notice.id,action:'unseen'}).state.notifications?.[0]?.seen).toBe(false);
 chats.close();
 const restoredAgents=new AgentOrchestrator(f.root),restoredChats=new PilotChats(f.root,{external:restoredAgents,graph:()=>[]});cleanups.push(()=>restoredChats.close(),()=>restoredAgents.close());
 expect(restoredChats.notifications()).toHaveLength(1);
 restoredAgents.approve(job.id,job.worker.request!.id,false,false);
 expect(restoredChats.notifications()[0]?.resolved).toBe(true);
 restoredChats.close();
 const file=join(f.root,'.spool','pilot-chats',pilot.id+'.json'),saved=JSON.parse(readFileSync(file,'utf8'));saved.notifications[0].resolved=false;writeFileSync(file,JSON.stringify(saved));
 const recoveredAgents=new AgentOrchestrator(f.root),recoveredChats=new PilotChats(f.root,{external:recoveredAgents,graph:()=>[]});cleanups.push(()=>recoveredChats.close());
 expect(recoveredChats.notifications()[0]?.resolved).toBe(true);

});


test('Pilot discovers launch models, returns the chosen identity, and rejects unavailable explicit choices',async()=>{
 const f=fixture(),chats=new PilotChats(f.root,{external:f.agents,graph:()=>[]});cleanups.push(()=>chats.close());
 const pilot=chats.create([]),signal=new AbortController().signal;
 chats.models=async()=>[{id:'pi/anthropic',label:'Claude',ready:true,models:[{id:'claude-sonnet-5',label:'Sonnet'}]}];
 const call=(name:string,args:Record<string,unknown>)=>(chats as any).executeTool(chats.get(pilot.id),name,args,signal);
 expect((await call('list_agent_models',{})).agents[0].id).toBe('pi/anthropic');
 const model={adapter:'pi',provider:'anthropic',model:'claude-sonnet-5'},args={title:'Atlas review',task:'Inspect project',context:'Synthetic context',cwd:dir(),model};
 expect(await call('launch_agent',{...args,model:{...model,model:'unavailable-model'}})).toMatchObject({error:expect.stringContaining('not connected or available')});
 expect(f.agents.list()).toHaveLength(0);
 expect(await call('launch_agent',args)).toMatchObject({status:'needs-input',model,request:{kind:'access',initial:true}});
 expect(f.requests()).toBe(0);
});


test('first-run setup can retain Pilot model inheritance instead of pinning the launch choice',async()=>{
 const f=fixture(),job=launch(f.agents,{cwd:dir()});
 f.agents.approve(job.id,job.worker.request!.id,true,true,{label:'Inherited model',mode:'read'});
 expect(f.agents.projects.get(job.worker.projectId!)?.model).toBeUndefined();
 await until(()=>job.status==='idle');
});

test('a running worker requests a named credential, waits for connection, and can receive it for one task',async()=>{
 const path=dir(),f=fixture([call('request_access',{reason:'Need package account',mode:'work',references:[],domains:[],accounts:[],credentials:['NPM_TOKEN']}),call('bash',{command:'test "$NPM_TOKEN" = synthetic-package-token'}),call('ask_user',{question:'Continue?'}),{result:'Done'}]);
 const p=authorize(f.agents.projects,path),job=launch(f.agents,{project:p.id});
 await until(()=>job.worker.request?.kind==='access');const request=job.worker.request!;
 expect(f.reports.at(-1)?.kind).toBe('access');
 expect(()=>f.agents.approve(job.id,request.id,true,false)).toThrow('Reconnect');
 expect(job.worker.request?.id).toBe(request.id);
 f.agents.projects.connect(path,{NPM_TOKEN:'synthetic-package-token'});
 f.agents.approve(job.id,request.id,true,false,{label:'Atlas',mode:'work',credentials:['NPM_TOKEN']});
 await until(()=>job.worker.request?.kind==='question');
 expect(job.worker.operations[0]?.status).toBe('completed');
 expect(f.agents.projects.get(p.id)?.credentials??[]).toEqual([]);
 f.agents.projects.connect(path,{NPM_TOKEN:null});expect(job.status).toBe('interrupted');
});

test('conversational environment proposals wait for approval, revise scopes, and reject stale or foreign decisions',async()=>{
 const f=fixture(),path=dir(),chats=new PilotChats(f.root,{external:f.agents,graph:()=>[]});cleanups.push(()=>chats.close());
 const pilot=chats.create([]),environment={label:'Atlas environment',mode:'work',domains:['api.example.com']};
 const job=launch(f.agents,{cwd:path,environment},pilot.id),first=job.worker.request!;
 expect(job.status).toBe('needs-input');expect(f.requests()).toBe(0);expect(f.agents.projects.list()).toHaveLength(0);
 expect(first).toMatchObject({label:'Atlas environment',grant:{path,mode:'work',domains:['api.example.com']}});
 expect(()=>f.agents.reviseEnvironment('foreign-pilot',job.id,first.id,{...environment,domains:[]})).toThrow('different Pilot');
 f.agents.reviseEnvironment(pilot.id,job.id,first.id,{...environment,domains:[],mode:'read'});
 const next=job.worker.request!;expect(next.id).not.toBe(first.id);expect(f.requests()).toBe(0);
 expect(chats.notifications().filter(n=>!n.resolved)).toHaveLength(1);
 expect(chats.notifications().find(n=>n.key===`${job.id}:${first.id}`)?.resolved).toBe(true);
 expect(()=>f.agents.approve(job.id,first.id,true,true)).toThrow('no longer');
 expect(()=>f.agents.reviseEnvironment(pilot.id,job.id,first.id,environment)).toThrow('no longer');
 f.agents.approve(job.id,next.id,true,true);await until(()=>job.status==='idle');
 expect(f.agents.projects.at(path)).toMatchObject({label:'Atlas environment',mode:'read',domains:[]});
 expect(chats.notifications().every(n=>n.resolved)).toBe(true);
 const reuse=launch(f.agents,{cwd:path},pilot.id);await until(()=>reuse.status==='idle');expect(f.requests()).toBe(2);
});

test('Pilot prepares setup with read-only discovery and validates conversational model revisions without granting access',async()=>{
 const f=fixture(),path=dir(),chats=new PilotChats(f.root,{external:f.agents,graph:()=>[]});cleanups.push(()=>chats.close());
 const pilot=chats.create([]),signal=new AbortController().signal;
 chats.models=async()=>[{id:'pi/anthropic',label:'Claude',ready:true,models:[{id:'claude-sonnet-5',label:'Sonnet'}]}];
 f.agents.projects.connect(path,{EXAMPLE_TOKEN:'synthetic-secret'});
 const call=(name:string,args:Record<string,unknown>)=>(chats as any).executeTool(chats.get(pilot.id),name,args,signal);
 const info=await call('inspect_agent_environment',{path});expect(info.credentials).toEqual(['EXAMPLE_TOKEN']);expect(JSON.stringify(info)).not.toContain('synthetic-secret');
 const job=launch(f.agents,{cwd:path},pilot.id),request=job.worker.request!.id,environment={label:'Atlas',mode:'read'};
 expect(await call('revise_agent_environment',{agent:job.id,request,environment,model:{adapter:'pi',provider:'anthropic',model:'unavailable'}})).toMatchObject({error:expect.stringContaining('not connected or available')});
 expect(job.worker.request!.id).toBe(request);
 expect(await call('revise_agent_environment',{agent:job.id,request,environment,model:{adapter:'pi',provider:'anthropic',model:'claude-sonnet-5'}})).toMatchObject({status:'needs-input',model:{model:'claude-sonnet-5'}});
 expect(f.requests()).toBe(0);expect(f.agents.projects.list()).toHaveLength(0);
 expect(()=>launch(f.agents,{cwd:path,environment:{...environment,token:'must-not-store'}})).toThrow();
});

test('a one-task conversational expansion depends on saved authority, not its unapproved proposed scope',async()=>{
 const f=fixture(),path=dir(),project=authorize(f.agents.projects,path,'read');
 const environment={label:'Atlas command session',mode:'work',domains:[]};
 const job=launch(f.agents,{project:project.id,environment}),first=job.worker.request!.id;
 f.agents.reviseEnvironment('pilot',job.id,first,environment);
 f.agents.approve(job.id,job.worker.request!.id,true,false);await until(()=>job.status==='idle');
 expect(job.worker.grant?.mode).toBe('work');expect(f.agents.projects.get(project.id)?.mode).toBe('read');
});

// Exercise the production Pilot report turn and action ledger, not a direct
// orchestrator call. Model choices are scripted; these tests do not grade prose.
test('Pilot continues unfinished work on a report turn and retains ownership through status questions', async () => {
  const f = fixture([{ result: 'Change prepared; verification remains.' }, { result: 'Verification passed.' }]);
  let agent = '', reportTurns = 0;
  const seen: string[] = [];
  const chats = new PilotChats(f.root, { external: f.agents, graph: () => [], backend: setup => {
    expect(setup.instructions).toContain('You retain responsibility');
    expect(setup.instructions).toContain('answer yes or no first');
    return { broken: false, transport: 'subscription', prepare: async () => true, close() {}, turn: async turn => {
      const input = turn.input(true); seen.push(input);
      if (input.includes('This is an automatic report turn')) {
        reportTurns++;
        if (reportTurns === 1) {
          const record = f.agents.get(agent);
          for (let i = 0; i < 35; i++) record.messages.push({ id: `activity-${i}`, role: 'activity', text: 'Synthetic progress', at: record.updated });
        }
        const job = await turn.tool('read_agent', { agent }) as { task: string; messages: { text: string }[] };
        expect(job.task).toContain('verify');
        expect(job.messages).toHaveLength(30);
        expect(job.messages.some(m => m.text === job.task)).toBe(false);
        if (reportTurns === 1) {
          const args = { agent, text: 'Finish the requested verification in the existing task scope.' };
          const result = await turn.tool('message_agent', args) as { id?: string; error?: string };
          expect(result.error).toBeUndefined(); expect(result.id).toBe(agent);
          // Delivery retry reuses the receipt even while the worker is running.
          await turn.tool('message_agent', args);
          return 'Verification is running. No action is needed from you.';
        }
        return 'The change and verification are complete.';
      }
      if (!agent) {
        const job = await turn.tool('launch_agent', { title: 'Example change', task: 'Prepare the change and verify it.', context: 'Invented project evidence' }) as { id: string };
        agent = job.id;
        return 'Working on the change and verification.';
      }
      await turn.tool('read_agent', { agent });
      return 'No. The requested work is complete.';
    } };
  } });
  cleanups.push(() => chats.close());
  const pilot = chats.create([]);
  chats.send(pilot.id, 'Prepare the example change and verify it.');
  await until(() => reportTurns === 2 && pilot.phase === 'answered');
  chats.send(pilot.id, 'How is it going?'); await chats.settled(pilot.id);
  chats.send(pilot.id, 'Do you need anything from me?'); await chats.settled(pilot.id);
  expect(f.requests()).toBe(2);
  expect(f.agents.get(agent).messages.filter(m => m.role === 'user')).toHaveLength(2);
  expect(chats.actionReceipts(pilot.id).receipts.filter(r => r.operation === 'message_agent')).toHaveLength(1);
  expect(seen.at(-1)).toContain('Prepare the example change and verify it.');
});

for (const boundary of ['pending access', 'stopped', 'revoked', 'other task', 'other Pilot'] as const) {
  test(`automatic continuation respects ${boundary} and cannot launch new workers`, async () => {
    const f = fixture(boundary === 'pending access' ? [{ result: 'Prepared' }, call('request_access', { reason: 'Read a reference', mode: 'read', references: [], domains: ['example.com'], accounts: [] })] : undefined), project = dir(), saved = authorize(f.agents.projects, project, 'read');
    let agent = '', checked = false;
    const chats = new PilotChats(f.root, { external: f.agents, graph: () => [], backend: () => ({
      broken: false, transport: 'subscription', prepare: async () => true, close() {}, turn: async turn => {
        if (!turn.input(true).includes('This is an automatic report turn')) {
          const job = await turn.tool('launch_agent', { title: 'Example task', task: 'Read the project and verify findings', context: 'Invented evidence',
            project: saved.id }) as { id: string };
          agent = job.id;
          return 'Task prepared.';
        }
        if (checked) return 'Already handled.';
        checked = true;
        await expect(turn.tool('launch_agent', { title: 'Unrequested task', task: 'New work', context: '' })).rejects.toThrow('Automatic agent reports');
        let target = agent;
        if (boundary === 'pending access') {
          await f.agents.message(agent, 'Prepare the missing reference access request.');
          await until(() => f.agents.get(agent).worker.request?.kind === 'access');
        }
        if (boundary === 'stopped') await f.agents.interrupt(agent);
        if (boundary === 'revoked') f.agents.projects.remove(saved.id);
        if (boundary === 'other task' || boundary === 'other Pilot') {
          const owner = boundary === 'other task' ? f.agents.get(agent).origin.pilot : 'another-pilot';
          const other = launch(f.agents, { project: saved.id }, owner);
          await f.agents.settled(other.id); target = other.id;
        }
        const result = await turn.tool('message_agent', { agent: target, text: 'Continue verification.' }) as { error: string };
        expect(result.error).toContain(boundary === 'other Pilot' ? 'different Pilot'
          : boundary === 'pending access' ? 'pending request'
          : boundary === 'other task' ? 'this report turn'
          : 'stopped work');
        if (boundary === 'pending access') {
          const job = f.agents.get(agent);
          expect(job.worker.request?.kind).toBe('access');
          expect(job.worker.grant?.domains).toEqual([]);
          expect(f.requests()).toBe(2);
          await expect(turn.tool('reply_agent', { agent, request: job.worker.request!.id, text: 'Approved', evidence: [] })).resolves.toMatchObject({ error: expect.any(String) });
          expect(job.worker.request?.kind).toBe('access');
          expect(job.worker.grant?.domains).toEqual([]);
        }
        return 'Waiting for the existing task decision.';
      },
    }) });
    cleanups.push(() => chats.close());
    const pilot = chats.create([]); chats.send(pilot.id, 'Read the project and verify findings.');
    await until(() => pilot.phase === 'failed' || checked && pilot.phase === 'answered');
    expect(pilot.error).toBeFalsy(); expect(checked).toBe(true);
    expect(f.agents.get(agent).messages.filter(m => m.role === 'user')).toHaveLength(boundary === 'pending access' ? 2 : 1);
  });
}
