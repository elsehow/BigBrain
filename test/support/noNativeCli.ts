import { expect } from 'bun:test';
import { realpathSync, rmSync } from 'node:fs';
import { nativeVault, NATIVE_YAML } from './vault';
import { fakePi } from './pi';
import { setupState } from '../../lib/firstRun';
import { modelCatalog } from '../../lib/modelCatalog';
import { diagnosticsReport } from '../../lib/diagnostics';
import { runPreflight } from '../../lib/preflight';
import { runAgent } from '../../lib/run/agent';
import { PiSession } from '../../lib/run/piSession';
import { readChatgptQuota } from '../../lib/run/chatgptQuota';
const root = realpathSync(nativeVault({files:{'vault.yaml':NATIVE_YAML}}));
const choice = { adapter: 'pi' as const, provider: 'anthropic', model: 'claude-sonnet-5' };
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
  console.log('App workflows completed without native CLIs');
} finally { rmSync(root,{recursive:true,force:true}); }
