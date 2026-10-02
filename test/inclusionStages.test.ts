import {test,expect} from 'bun:test';
import {join} from 'node:path';
import {rmSync} from 'node:fs';
import {gitVault} from './support/vault';
import {accountPolicy,writeAccountPolicy,accountFingerprint} from '../lib/integrationAccess';
import {stagedHeads,admitStaged,passStaged,type StagedItem} from '../lib/stage';
import {stage} from '../lib/stageStorage';
import {stagedItems} from '../lib/stageStorage';
import {tickIntegrationInclusion,stageItemsForReview,stagedInclusionSource} from '../lib/inclusionStages';
import {integrationRuleScope,writeInclusionPolicy} from '../lib/inclusionPolicy';
import {inclusionEvaluator} from '../lib/inclusionEvaluation';
import {saveJevKey} from '../lib/jevSettings';
import {readSourceInsertionLog} from '../lib/insertionLog';
test('reviewed integration policy gates gardener bypass, imports includes, skips excludes and preserves inactive arrivals',async()=>{
 const root=gitVault({files:{'vault.yaml':'integrations:\n  email:\n    inboxes:\n      - address: example@example.test\n        host: imap.example.test\n','.env':'BIGBRAIN_IMAP_PASSWORD__EXAMPLE_EXAMPLE_TEST=fictional\n'}}),store=join(root,'connections.json'),scope=integrationRuleScope('email','example@example.test');
 const before=process.env.BIGBRAIN_SHARED_CONNECTIONS;process.env.BIGBRAIN_SHARED_CONNECTIONS=store;
 try{
  const text='Sources about project decisions.';const account='example@example.test';
  writeAccountPolicy(root,'email',account,{...accountPolicy(root,'email',account),connected:true,fingerprint:accountFingerprint(root,'email',account),remembering:{enabled:true,rule:text}});saveJevKey(store,'fictional');
  const item=(id:string):StagedItem=>({id,source:'email',account,at:new Date().toISOString(),line:'Example '+id,scopes:{},name:id+'.md',content:`---\nid: ${id}\ntitle: Example ${id}\nsource: email\nkind: email\n---\nComplete invented message ${id}.`});
  const yes=item('fixture-yes'),no=item('fixture-no'),later=item('fixture-later');for(const row of [yes,no])stage(root,row);
  expect(stageItemsForReview(root,'email',account)).toHaveLength(2);
  const policy={version:'v1',scope,text,updated:new Date().toISOString(),calibration:{identity:inclusionEvaluator(root,store,text).identity,threshold:.75},labels:[{source:stagedInclusionSource(yes),include:true},{source:stagedInclusionSource(no),include:false}]};policy.calibration.identity=inclusionEvaluator(root,store,text,policy.labels).identity;writeInclusionPolicy(root,store,policy);
  expect(stagedHeads(root)).toHaveLength(0);expect(admitStaged(root,[no.id])[0]!.ok).toBe(false);expect(passStaged(root,[yes.id],'bypass')[0]!.ok).toBe(false);
  await tickIntegrationInclusion(root,store);expect(stagedItems(root,'email')).toHaveLength(0);expect(readSourceInsertionLog(root).map(s=>s.title)).toEqual(['Example fixture-yes']);
  stage(root,later);const p=accountPolicy(root,'email',account);writeAccountPolicy(root,'email',account,{...p,remembering:{...p.remembering,enabled:false}});await tickIntegrationInclusion(root,store);expect(stagedItems(root,'email')).toHaveLength(1);
 }finally{if(before===undefined)delete process.env.BIGBRAIN_SHARED_CONNECTIONS;else process.env.BIGBRAIN_SHARED_CONNECTIONS=before;rmSync(root,{recursive:true,force:true});}
});

test('include everything automatically admits verbatim Granola, retaining older summary-only pending items',async()=>{
 const {fakeIntegrationActivation}=await import('./support/integrationActivation');
 const root=gitVault({files:{'vault.yaml':'integrations: {}\n'}}),store=join(root,'connections.json');
 const before=process.env.BIGBRAIN_SHARED_CONNECTIONS;process.env.BIGBRAIN_SHARED_CONNECTIONS=store;
 try{
  fakeIntegrationActivation(root,'granola');
  const current=accountPolicy(root,'granola','granola');writeAccountPolicy(root,'granola','granola',{...current,remembering:{enabled:true,rule:'Include everything.'}});
  for(let i=0;i<12;i++)stage(root,{id:'legacy-'+i,source:'granola',account:'granola',at:'2026-09-01',line:'Old note',scopes:{},name:'old.md',content:'---\nid: old-'+i+'\nsource: granola\nkind: meeting\n---\nVendor summary'});
  stage(root,{id:'raw-new',source:'granola',account:'granola',at:'2026-09-29',line:'Raw meeting',scopes:{},name:'raw.md',content:'---\nid: raw-new\nformat: granola-transcript-v1\nsource: granola\nkind: meeting\n---\nAttendees: Ada\n\nSpeaker: Exact words.'});
  expect(admitStaged(root,['legacy-0'])[0]?.ok).toBe(false);
  await tickIntegrationInclusion(root,store);
  expect(readSourceInsertionLog(root)).toHaveLength(1);expect(readSourceInsertionLog(root)[0]?.body).toContain('Speaker: Exact words.');expect(stagedItems(root,'granola')).toHaveLength(12);
 }finally{if(before===undefined)delete process.env.BIGBRAIN_SHARED_CONNECTIONS;else process.env.BIGBRAIN_SHARED_CONNECTIONS=before;rmSync(root,{recursive:true,force:true});}
});
