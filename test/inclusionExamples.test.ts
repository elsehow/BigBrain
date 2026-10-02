import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inclusionEvaluator} from '../lib/inclusionEvaluation';
import {saveJevKey} from '../lib/jevSettings';
import {ruleEvaluator} from '../lib/sharedRuleEvaluator';
import {teachingExamples,inclusionExcerpt} from '../lib/inclusionExamples';
import type {runAgent} from '../lib/run/agent';
test('examples change cached predictions for unseen candidates and reach both providers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'teaching-')),store=join(root,'connections.json'),old=globalThis.fetch;
 try{
  writeFileSync(join(root,'vault.yaml'),'quick:\n  adapter: pi\n  provider: anthropic\n  model: example\n');saveJevKey(store,'invented');
  const source={id:'a',title:'Project conversation',body:'A mixed personal and project discussion.',origin:'Fixture'},candidate={title:'Another project conversation',body:'A different complete source.'};
  const labels=[{source,include:false}];let requests=0;
  globalThis.fetch=(async(_url,init)=>{requests++;const body=JSON.parse(String(init?.body));expect(body.state.source.body).toBe(candidate.body);return Response.json({answers:{relevant:{noul:body.state.examples?.[0]?.include===false?.1:.9}}});}) as typeof fetch;
  const first=inclusionEvaluator(root,store,'Project material');expect(await first.score(candidate)).toBe(.9);
  const taught=inclusionEvaluator(root,store,'Project material',labels);expect(taught.identity).not.toBe(first.identity);expect(await taught.score(candidate)).toBe(.1);expect(await taught.score(candidate)).toBe(.1);expect(requests).toBe(2);
  expect(teachingExamples(labels,source)).toEqual([]);
  saveJevKey(store,null);const examples=teachingExamples(labels,candidate);
  const run=(async req=>{expect(JSON.parse(req.prompt).examples).toEqual(examples);expect(JSON.parse(req.prompt).source.body).toBe(candidate.body);return {text:'{"relevant":0.1}'};}) as typeof runAgent;
  expect((await ruleEvaluator(root,store,run,examples).evaluate('Project material',[],candidate)).relevant).toBe(.1);
  expect(inclusionExcerpt('# Repeated title\nSession `example`, lines 1–20\n--- TRANSCRIPT ---\nuser: Useful content.')).toBe('user: Useful content.');
 }finally{globalThis.fetch=old;rmSync(root,{recursive:true,force:true});}
});
