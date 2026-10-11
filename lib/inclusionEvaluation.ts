import {teachingExamples} from './inclusionExamples';
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {sha256hex} from './hash';
import {writeAtomic} from './fsx';
import {ruleEvaluator} from './sharedRuleEvaluator';
import {noteClaims,ruleMentionContext} from './sharedRuleMentions';
import {sourceDigest,type InclusionSource,type InclusionLabel} from './inclusionPolicy';
// Scores already read this run, by cache file: a lens pass reads every note's score every tick.
const remembered=new Map<string,number>();
/** What a score was read from changed in a BigBrain update: 3 gave the evaluator each note's claims. A lens records it (lib/lenses.ts). */
export const EVALUATOR_VERSION=3;
export function inclusionEvaluator(root:string,store:string,text:string,labels:InclusionLabel[]=[]) {
 const evaluator=ruleEvaluator(root,store),entities=ruleMentionContext(root,text).map(e=>({id:e.id,title:e.title,aliases:e.aliases})),claimed=noteClaims(root);
 const identity=sha256hex(JSON.stringify({version:EVALUATOR_VERSION,labels:labels.map(l=>({digest:sourceDigest(l.source),include:l.include})),evaluator:evaluator.identity,text,entities}));
 const directory=join(dirname(store),'inclusion-scores');mkdirSync(directory,{recursive:true,mode:0o700});
 const cached=(path:string)=>{
  const known=remembered.get(path);if(known!==undefined)return known;
  if(!existsSync(path))return undefined;
  const value=JSON.parse(readFileSync(path,'utf8')).score;if(typeof value!=='number'||value<0||value>1)return undefined;
  if(remembered.size>=200_000)remembered.clear();remembered.set(path,value);return value;
 };
 /** `id` is the note revision (its insertion id), whose claims the evaluator reads with it; `digest` is `sourceDigest(source)` when the caller already has it. */
 return {identity,model:JSON.stringify(evaluator.identity),async score(source:Pick<InclusionSource,'id'|'title'|'body'>,digest=sourceDigest(source)){
  // A note's claims are part of what is scored, so new claims score it again; a note without claims keeps the score it had.
  const claims=claimed.get(source.id),path=join(directory,sha256hex(identity+digest+(claims?JSON.stringify(claims):''))+'.json'),known=cached(path);if(known!==undefined)return known;
  const decision=await ruleEvaluator(root,store,undefined,teachingExamples(labels,source)).evaluate(text,entities,{title:source.title,body:source.body,...claims});writeAtomic(path,JSON.stringify({score:decision.relevant}),0o600);remembered.set(path,decision.relevant);return decision.relevant;
 }};
}
