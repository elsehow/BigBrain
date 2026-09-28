import { expect } from 'bun:test';
import { realpathSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeVault, NATIVE_YAML } from './vault';
import { fakePi } from './pi';
import { setupState } from '../../lib/firstRun';
import { modelCatalog } from '../../lib/modelCatalog';
import { diagnosticsReport } from '../../lib/diagnostics';
import { runPreflight } from '../../lib/preflight';
import { runAgent } from '../../lib/run/agent';
import { PiSession } from '../../lib/run/piSession';
import { readChatgptQuota } from '../../lib/run/chatgptQuota';
import { AgentOrchestrator } from '../../lib/agentOrchestrator';
const root = realpathSync(nativeVault({files:{'vault.yaml':NATIVE_YAML}}));
const choice = { adapter: 'pi' as const, provider: 'anthropic', model: 'claude-sonnet-5' };
let agents: AgentOrchestrator | undefined;
try {
  const state = setupState(root); expect(state.vault?.path).toBe(root);
  expect((await modelCatalog(state)).some(p => p.id === 'pi/anthropic')).toBe(true);
  expect(diagnosticsReport(root).facts.connection?.provider).toBe('anthropic');
  expect(runPreflight({root,provider:'anthropic'}).some(c=>c.name==='model-connection')).toBe(true);
  for (const [role, capabilities] of [['quick','none'],['memory','memory'],['tend','gardener']] as const) {
    const result = await runAgent({root,role,capabilities,target:choice,auth:'max',prompt:'Synthetic check',output:{requireText:true}},fakePi(()=>({result:'Ready'})));
    expect(result.text).toBe('Ready');
  }
  const setup = {root,config:choice,instructions:'Synthetic Pilot',tools:[],state:{through:0},save(){}};
  const turn = {signal:new AbortController().signal,input:()=> 'Ready?',delta(){},tool:async()=>null,connected(){}};
  const session = new PiSession(setup,fakePi(()=>({result:'Ready'})));
  expect(await session.turn(turn)).toBe('Ready'); session.close();
  const resumed = new PiSession(setup,fakePi(()=>({result:'Resumed'})));
  expect(await resumed.turn(turn)).toBe('Resumed'); resumed.close();
  expect(await readChatgptQuota('invalid',turn.signal)).toEqual([]);
  let count = 0;
  agents = new AgentOrchestrator(root,{loadPi:fakePi(()=>++count===1?{content:[{type:'toolCall',id:'write',name:'write',arguments:{path:'result.txt',content:'Ready'}}]}:{result:'Finished'})});
  const job = agents.launch('pilot','message',{title:'Synthetic check',task:'Write result.txt',context:'Fixture'},[]);
  for (let i=0;i<500 && !['idle','failed'].includes(job.status);i++) await Bun.sleep(10);
  expect(job.error).toBeUndefined(); expect(job.status).toBe('idle');
  expect(readFileSync(join(job.cwd,'result.txt'),'utf8')).toBe('Ready');
  agents.close(); agents = new AgentOrchestrator(root,{loadPi:async()=>{throw Error('Restart must not dispatch');}});
  expect(agents.get(job.id).status).toBe('idle');
  console.log('App workflows completed without native CLIs');
} finally { agents?.close(); rmSync(root,{recursive:true,force:true}); }
