import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ruleEvaluator} from '../lib/sharedRuleEvaluator';
import {saveJevKey} from '../lib/jevSettings';
import type {runAgent} from '../lib/run/agent';
test('no Jev key uses the configured Quick connection with the complete source and no tools',async()=>{
 const root=mkdtempSync(join(tmpdir(),'quick-inclusion-')),store=join(root,'connections.json');
 try{
  writeFileSync(join(root,'vault.yaml'),'quick:\n  adapter: pi\n  provider: anthropic\n  model: example-quick\n');saveJevKey(store,null);
  const source={title:'Example',body:'x'.repeat(40000)},rule='Sources about Example.';
  let calls=0;
  const run=(async(request)=>{calls++;expect(request.target.model).toBe('example-quick');expect(request.role).toBe('quick');expect(request.capabilities).toBe('none');expect(JSON.parse(request.prompt)).toEqual({question:'Does this meet the inclusion rule?',rule,entities:[],source});return {text:'{"relevant":0.77}',usage:{input_tokens:500}};}) as typeof runAgent;
  const evaluator=ruleEvaluator(root,store,run);expect(evaluator.identity).toMatchObject({role:'quick',model:'example-quick'});
  expect(await evaluator.evaluate(rule,[],source)).toMatchObject({include:false,relevant:.77,model:'example-quick'});expect(calls).toBe(1);
  saveJevKey(store,'example-jev-key');expect(ruleEvaluator(root,store,run).identity).toMatchObject({provider:'typesafe'});expect(calls).toBe(1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
