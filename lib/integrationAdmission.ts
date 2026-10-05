/**
 * integrationAdmission.ts — where what a managed integration found becomes an
 * arrival (#80). For an account that remembers, each staged item is admitted,
 * or passed when the worth gate (lib/worthGate.ts) scores it under its
 * cut-off. The firewall screened it before it was staged (lib/door.ts), and
 * the gardener files what is admitted. There are no per-account rules: the
 * gate is the one judgment of what is worth gardening.
 *
 * Runs every 30 s from the viewer's server (web/server.ts). A failure leaves
 * the item staged and retries it after 15 minutes.
 */
import {parseEnvelope} from './envelope';
import {stagedItems,type StagedItem} from './stageStorage';
import {stagedAccount,admitStaged,passStaged} from './stage';
import {integrationActive,integrationAccounts,MANAGED_INTEGRATIONS} from './integrationAccess';
import type {InclusionSource} from './inclusionPolicy';
import {connectionStorePath} from './sharedConnections';
import {loadManifest} from './manifest';
import {gateDecide,gated,recordGateDecision} from './worthGate';

/** A staged item as the gate reads it: the whole arrival. */
export function stagedSource(s:StagedItem):InclusionSource {
 let title=s.line;try{title=String(parseEnvelope(s.content).envelope.title??s.line);}catch{/* the head line stands in */}
 return {id:s.id,title,body:s.content,origin:`${s.source} · ${s.at.slice(0,10)}`};
}

/** Items per account per tick. */
const BATCH=50;
const running=new Set<string>(),retryAfter=new Map<string,number>();

export async function tickIntegrationAdmission(root:string,store=connectionStorePath()):Promise<void>{
 if(running.has(root))return;running.add(root);
 try{
  const gate=loadManifest(root).gate;
  for(const name of MANAGED_INTEGRATIONS)for(const account of integrationAccounts(root,name)){
   if(!integrationActive(root,name,account))continue;
   const pending=stagedItems(root,name).filter(s=>stagedAccount(root,s)===account)
    // Granola lands verbatim transcripts only; older summary-only items stay pending
    .filter(s=>name!=='granola'||parseEnvelope(s.content).envelope.format==='granola-transcript-v1').slice(0,BATCH);
   for(const item of pending){
    const key=JSON.stringify([root,item.id]);if((retryAfter.get(key)??0)>Date.now())continue;
    try{
     const d=gate&&gated(gate,name)?await gateDecide({root,store,cfg:gate,source:name,item:stagedSource(item)}):undefined;
     if(!integrationActive(root,name,account))break;
     if(d&&!d.admitted){
      recordGateDecision(root,d);
      const r=passStaged(root,[item.id],`Under the worth gate's cut-off (${d.score?.toFixed(2)} < ${d.threshold}).`);
      if(!r[0]?.ok)throw Error(r[0]?.error??'Could not pass the item');
     }else{
      const r=admitStaged(root,[item.id]),insertion_id=r[0]?.insertion_id;
      if(d)recordGateDecision(root,{...d,...(insertion_id?{insertion_id}:{})});
      if(!r[0]?.ok)throw Error(r[0]?.error??'Could not admit the item');
     }
     retryAfter.delete(key);
    }catch{retryAfter.set(key,Date.now()+15*60000);}
   }
  }
 }finally{running.delete(root);}
}
