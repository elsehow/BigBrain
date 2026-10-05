import {includesEverything} from './inclusionMode';
import {parseEnvelope} from './envelope';
import type {StagedItem} from './stageStorage';
/** Integration adapter: the same inclusion decision as shared vaults. */
import {stagedItems} from './stageStorage';
import {stagedAccount,admitStaged,passStaged} from './stage';
import {readSourceInsertionLog} from './insertionLog';
import {accountPolicy,integrationActive,integrationAccounts,MANAGED_INTEGRATIONS,accountFingerprint} from './integrationAccess';
import {integrationRuleScope,readInclusionPolicy,writeInclusionStatus,type InclusionSource} from './inclusionPolicy';
import {decideInclusion} from './inclusionEvaluation';
import {connectionStorePath} from './sharedConnections';
import {recordInclusionPermit} from './inclusionStagePermit';
import {loadManifest} from './manifest';
import {gateDecide,recordGateDecision} from './worthGate';
export function stagedInclusionSource(s:StagedItem):InclusionSource {let title=s.line;try{title=String(parseEnvelope(s.content).envelope.title??s.line);}catch{}return {id:s.id,title,body:s.content,origin:`${s.source} · ${s.at.slice(0,10)}`};}
export function stageItemsForReview(root:string,name:string,account:string):InclusionSource[]{
 const pending=stagedItems(root,name).filter(s=>stagedAccount(root,s)===account).map(stagedInclusionSource);
 const prior=readSourceInsertionLog(root,{strict:true}).filter(s=>s.envelope.source===name&&(s.envelope.inbox===account||s.envelope.account===account||(account===name&&!s.envelope.inbox&&!s.envelope.account))).map(s=>({id:s.id,title:s.title,body:s.body,origin:`${name} · ${(s.received_at??'').slice(0,10)}`}));
 return [...pending,...prior.reverse()];
}
const running=new Set<string>(),retryAfter=new Map<string,number>();
export async function tickIntegrationInclusion(root:string,store=connectionStorePath()){
 if(running.has(root))return;running.add(root);
 try{for(const name of MANAGED_INTEGRATIONS)for(const account of integrationAccounts(root,name)){
  const scope=integrationRuleScope(name,account),policy=readInclusionPolicy(root,store,scope);
  if(!integrationActive(root,name,account)||(!policy&&!includesEverything(accountPolicy(root,name,account).remembering.rule)))continue;
  const text=accountPolicy(root,name,account).remembering.rule,fingerprint=accountFingerprint(root,name,account);
  for(const item of stagedItems(root,name).filter(s=>stagedAccount(root,s)===account).filter(s=>name!=='granola'||!includesEverything(text)||parseEnvelope(s.content).envelope.format==='granola-transcript-v1').slice(0,10)){
   const retryKey=JSON.stringify([root,scope,policy?.version,item.id]);if((retryAfter.get(retryKey)??0)>Date.now())continue;
   try{
    const include=await decideInclusion(root,store,scope,text,stagedInclusionSource(item));
    // the worth gate (#80): an include-everything source it names is still scored, and may be passed
    const gate=include&&includesEverything(text)?loadManifest(root).gate:undefined;
    const gated=gate?.sources.includes(name)?await gateDecide({root,store,cfg:gate,source:name,item:stagedInclusionSource(item)}):undefined;
    if(!integrationActive(root,name,account)||accountFingerprint(root,name,account)!==fingerprint||readInclusionPolicy(root,store,scope)?.version!==policy?.version||accountPolicy(root,name,account).remembering.rule!==text)break;
    recordInclusionPermit(root,store,scope,policy?.version??'include-everything',text,item,include);
    if(gated&&!gated.admitted)recordGateDecision(root,gated); // first: it is the permit to pass
    const admitted=include&&(gated?.admitted??true)?admitStaged(root,[item.id]):undefined;
    const result=admitted??passStaged(root,[item.id],gated?`Under the worth gate's cut-off (${gated.score?.toFixed(2)} < ${gated.threshold}).`:'Excluded by the reviewed inclusion rule.');
    const insertion_id=admitted?.[0]?.insertion_id;
    if(gated?.admitted)recordGateDecision(root,{...gated,...(insertion_id?{insertion_id}:{})});
    if(!result[0]?.ok)throw Error(result[0]?.error??'Could not apply inclusion decision');
    writeInclusionStatus(root,store,scope);retryAfter.delete(retryKey);
   }catch(e){retryAfter.set(retryKey,Date.now()+15*60000);writeInclusionStatus(root,store,scope,e instanceof Error?e.message:'Could not evaluate an incoming source.');}
  }
 }}finally{running.delete(root);}
}
