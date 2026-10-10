/**
 * Adding EXISTING matches to a shared vault. A saved rule only shares sources
 * that arrive after it is saved (lib/sharedRules.ts tickRules); this is the
 * explicit step for everything already in the personal vault.
 *
 * It never scores the whole vault. The rule's search phrases (lib/inclusionQueries.ts)
 * rank every source not yet contributed, the top POOL are scored with the saved,
 * calibrated rule, and those at or above its threshold are shown as matches. Each
 * thumbs up or down is a label on the saved policy — the rule learns, so future
 * arrivals are judged with it too — and the likely candidates are re-scored after a
 * pause. Nothing is uploaded until `addBackfill`.
 *
 * A note already labelled on the policy (thumbs up or down while reviewing the rule)
 * keeps that answer here: it is not re-scored, and a kept one is listed whatever its
 * rank. A note whose scoring failed is counted as `failed`, never silently as a miss.
 */
import {randomUUID} from 'node:crypto';
import {modelErrText} from './errText';
import {readSourceInsertionLog,type SourceInsertion} from './insertionLog';
import {sharedRequest,type SharedConnection} from './sharedConnections';
import {contributions,getRule,sendSources,sourceKey} from './sharedRules';
import {inclusionEvaluator} from './inclusionEvaluation';
import {inclusionExcerpt} from './inclusionExamples';
import {rankCandidates} from './inclusionCandidates';
import {ruleQueries} from './inclusionQueries';
import {readInclusionPolicy,writeInclusionPolicy,sharedRuleScope,sourceDigest,type InclusionPolicy,type InclusionSource} from './inclusionPolicy';
import {resolveRuleMentions,ruleCandidateFilter} from './sharedRuleMentions';
import {OutOfCredits} from './sharedJev';

/** How many ranked sources are scored at most; a broad rule's matches beyond this wait for new arrivals. */
export const POOL=200;
/** After a rating, re-score unrated candidates at least this likely, at most RESCORE_CAP of them. */
const RESCORE_FLOOR=.4,RESCORE_CAP=60,RESCORE_PAUSE_MS=1500,CONCURRENCY=3;

type Evaluator=ReturnType<typeof inclusionEvaluator>;
interface Backfill {
 id:string;root:string;store:string;connection:SharedConnection;scope:string;text:string;threshold:number;
 pool:InclusionSource[];scores:Map<string,number>;rated:Map<string,boolean>;
 busy:boolean;scanned:number;failed:number;failure?:string;error?:string;added?:number;generation:number;at:number;timer?:ReturnType<typeof setTimeout>;
 factory:typeof inclusionEvaluator;queries:typeof ruleQueries;
 /** Shared source ids already contributed; injectable for tests. */
 existing:()=>Promise<Set<string>>;
}
const sessions=new Map<string,Backfill>();

const asSource=(s:SourceInsertion):InclusionSource=>({id:s.id,title:s.title,body:s.body,origin:`Personal · ${(s.received_at??s.occurred_at??'').slice(0,10)}`});
function latestSources(root:string){const latest=new Map<string,SourceInsertion>();for(const s of readSourceInsertionLog(root,{strict:true}))latest.set(s.source_id,s);return [...latest.values()].reverse();}
function savedPolicy(b:Pick<Backfill,'root'|'store'|'scope'|'text'>):InclusionPolicy{
 const policy=readInclusionPolicy(b.root,b.store,b.scope);
 if(!policy?.calibration||policy.text!==b.text)throw Error('Review and save the inclusion rule first.');
 return policy;
}

export function backfillState(b:Backfill){
 const matches=b.pool.filter(s=>b.rated.get(s.id)??((b.scores.get(s.id)??0)>=b.threshold)).filter(s=>b.rated.get(s.id)!==false)
  .sort((x,y)=>Number(b.rated.get(y.id)===true)-Number(b.rated.get(x.id)===true)||(b.scores.get(y.id)??0)-(b.scores.get(x.id)??0));
 return {id:b.id,busy:b.busy,scanned:b.scanned,total:b.pool.length,failed:b.failed,failure:b.failure,error:b.error,added:b.added,
  matches:matches.map(({id,title,origin,body})=>({id,title,origin,excerpt:inclusionExcerpt(body),body,kept:b.rated.get(id)===true}))};
}

export function getBackfill(root:string,id:string){const b=sessions.get(id);if(!b||b.root!==root)throw Error('This list expired. Open it again.');b.at=Date.now();return b;}

async function scoreAll(b:Backfill,items:InclusionSource[],evaluator:Evaluator,generation:number,count=true){
 let next=0;
 await Promise.all(Array.from({length:CONCURRENCY},async()=>{while(next<items.length&&b.generation===generation){const s=items[next++]!;try{const score=await evaluator.score(s);if(b.generation===generation){b.scores.set(s.id,score);if(count)b.scanned++;}}catch(e){if(e instanceof OutOfCredits)throw e;if(b.generation===generation&&count){b.scanned++;b.failed++;b.failure=modelErrText(e);}}}}));
}

export interface BackfillDeps {factory?:typeof inclusionEvaluator;queries?:typeof ruleQueries;existing?:()=>Promise<Set<string>>}
export async function startBackfill(root:string,store:string,connection:SharedConnection,opts:BackfillDeps={}){
 const rule=getRule(store,connection.id);if(!rule||rule.root!==root)throw Error('Save an inclusion rule for this vault first.');
 const scope=sharedRuleScope(connection.id),factory=opts.factory??inclusionEvaluator,queries=opts.queries??ruleQueries;
 const existing=opts.existing??(async()=>new Set((await contributions(connection)).map(c=>c.source_id)));
 const policy=savedPolicy({root,store,scope,text:rule.text});
 for(const [id,s] of sessions)if(s.connection.id===connection.id||Date.now()-s.at>3600000){s.generation++;clearTimeout(s.timer);sessions.delete(id);}
 const b:Backfill={id:randomUUID(),root,store,connection,scope,text:rule.text,threshold:policy.calibration!.threshold,pool:[],scores:new Map(),rated:new Map(),busy:true,scanned:0,failed:0,generation:0,at:Date.now(),factory,queries,existing};
 sessions.set(b.id,b);
 void (async()=>{const generation=b.generation;try{
  const blocked=await existing();
  const candidates=latestSources(root).filter(s=>!blocked.has('origin:'+sourceKey(s))).filter(ruleCandidateFilter(root,rule.text)).map(asSource);
  let mentioned:ReturnType<typeof resolveRuleMentions>=[];try{mentioned=resolveRuleMentions(root,rule.text);}catch{/* rank by words alone */}
  const q=await queries(root,store,rule.text,mentioned);
  const labelled=new Map(policy.labels.map(l=>[sourceDigest(l.source),l.include]));
  for(const s of candidates){const include=labelled.get(sourceDigest(s));if(include!==undefined)b.rated.set(s.id,include);}
  const ranked=rankCandidates(candidates,rule.text,q?.subjects??mentioned,q?.phrases??[]).slice(0,POOL);
  b.pool=[...candidates.filter(s=>b.rated.get(s.id)===true&&!ranked.includes(s)),...ranked];
  b.scanned=b.pool.filter(s=>b.rated.has(s.id)).length;
  await scoreAll(b,b.pool.filter(s=>!b.rated.has(s.id)),factory(root,store,rule.text,policy.labels),generation);
 }catch(e){if(b.generation===generation)b.error=e instanceof OutOfCredits?'Out of usage credits. (You need credits to find matches for your inclusion rule.)':e instanceof Error?e.message:'Could not find matches.';}
 finally{if(b.generation===generation)b.busy=false;}})();
 return backfillState(b);
}

/** A thumbs up keeps a match (and teaches the rule); a thumbs down drops it (and teaches the rule). */
export function rateBackfill(b:Backfill,sourceId:string,include:boolean){
 if(typeof include!=='boolean')throw Error('Choose include or exclude.');
 const source=b.pool.find(s=>s.id===sourceId);if(!source)throw Error('Choose a listed note.');
 const policy=savedPolicy(b),score=b.scores.get(sourceId);
 const evaluatorBefore=b.factory(b.root,b.store,b.text,policy.labels);
 policy.labels=policy.labels.filter(l=>sourceDigest(l.source)!==sourceDigest(source));
 policy.labels.push({source,include,...(score===undefined?{}:{prediction:{score,identity:evaluatorBefore.identity}})});
 const evaluator=b.factory(b.root,b.store,b.text,policy.labels);
 const saved={...policy,version:randomUUID(),updated:new Date().toISOString(),calibration:{identity:evaluator.identity,threshold:b.threshold}};
 writeInclusionPolicy(b.root,b.store,saved);writeInclusionPolicy(b.root,b.store,saved,true);
 b.rated.set(sourceId,include);
 // Re-score after a pause, so a run of ratings costs one pass.
 const generation=++b.generation;clearTimeout(b.timer);b.busy=true;
 b.timer=setTimeout(()=>{void (async()=>{
  const again=b.pool.filter(s=>!b.rated.has(s.id)&&(b.scores.get(s.id)??0)>=RESCORE_FLOOR).sort((x,y)=>(b.scores.get(y.id)??0)-(b.scores.get(x.id)??0)).slice(0,RESCORE_CAP);
  try{await scoreAll(b,again,b.factory(b.root,b.store,b.text,saved.labels),generation,false);}catch{/* keep previous scores */}
  if(b.generation===generation)b.busy=false;
 })();},RESCORE_PAUSE_MS);
 return backfillState(b);
}

/** Upload the current matches: kept ones and unrated ones at or above the threshold. */
export async function addBackfill(b:Backfill,send:typeof sendSources=sendSources){
 if(b.busy)throw Error('Wait for the matches to finish updating.');
 const blocked=await b.existing();
 const ids=new Set(backfillState(b).matches.map(m=>m.id));
 const rows=latestSources(b.root).filter(s=>ids.has(s.id)&&!blocked.has('origin:'+sourceKey(s)));
 b.added=await send(b.store,b.connection,rows);
 sessions.delete(b.id);
 return {added:b.added};
}

/** Whether the connection can take contributions: a read-only member is refused before any scoring. */
export async function assertCanContribute(c:SharedConnection){const who=await sharedRequest<{permissions:string[]}>(c,'/v1/whoami');if(!who.permissions.includes('write'))throw Error('This server is read-only.');}
