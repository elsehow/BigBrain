import {test,expect} from 'bun:test';
import {join} from 'node:path';
import {rmSync} from 'node:fs';
import {gitVault} from './support/vault';
import {accountPolicy,writeAccountPolicy,accountFingerprint} from '../lib/integrationAccess';
import {stage,stagedHeads,admitStaged,passStaged,type StagedItem} from '../lib/stage';
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
