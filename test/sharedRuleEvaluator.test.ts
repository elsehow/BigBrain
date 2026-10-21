import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ruleEvaluator} from '../lib/stages/ruleEvaluator';
import {saveJevKey} from '../lib/jevSettings';
import type {runAgent} from '../lib/run/agent';
import {ruleQueries} from '../lib/stages/ruleQueries';
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
test('Quick inclusion scoring and rule queries pass cancellation to the model runner',async()=>{
 const root=mkdtempSync(join(tmpdir(),'quick-cancellation-')),store=join(root,'connections.json');
 try{
  writeFileSync(join(root,'vault.yaml'),'quick:\n  adapter: pi\n  provider: anthropic\n  model: example-quick\n');saveJevKey(store,null);
  for(const kind of ['score','queries']){
   const controller=new AbortController();let received:AbortSignal|undefined;
   const run=(async request=>{
    received=request.signal;
    return await new Promise((_resolve,reject)=>request.signal!.addEventListener('abort',()=>reject(request.signal!.reason),{once:true}));
   }) as typeof runAgent;
   const pending=kind==='score'?ruleEvaluator(root,store,run).evaluate('Example rule',[],{title:'Example',body:'Invented note'},controller.signal)
    :ruleQueries(root,store,'Example rule',[],run,controller.signal);
   expect(received).toBe(controller.signal);
   controller.abort();await expect(pending).rejects.toMatchObject({name:'AbortError'});
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('a cancelled query answer cannot populate the query cache or become a fallback',async()=>{
 const root=mkdtempSync(join(tmpdir(),'query-cancellation-')),store=join(root,'connections.json');
 try{
  writeFileSync(join(root,'vault.yaml'),'integrations: {}\n');
  const controller=new AbortController();let calls=0;
  const run=(async()=>{if(++calls===1)controller.abort();return {text:'{"phrases":["orchard"],"subjects":[]}'};}) as typeof runAgent;
  await expect(ruleQueries(root,store,'Example rule',[],run,controller.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(await ruleQueries(root,store,'Example rule',[],run)).toEqual({phrases:['orchard'],subjects:[]});
  expect(calls).toBe(2);
 }finally{rmSync(root,{recursive:true,force:true});}
});
