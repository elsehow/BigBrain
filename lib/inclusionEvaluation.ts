import {teachingExamples} from './inclusionExamples';
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {sha256hex} from './hash';
import {writeAtomic} from './fsx';
import {ruleEvaluator} from './sharedRuleEvaluator';
import {ruleMentionContext} from './sharedRuleMentions';
import {readInclusionPolicy,sourceDigest,type InclusionSource,type InclusionLabel} from './inclusionPolicy';
export function inclusionEvaluator(root:string,store:string,text:string,labels:InclusionLabel[]=[]) {
 const evaluator=ruleEvaluator(root,store),entities=ruleMentionContext(root,text).map(e=>({id:e.id,title:e.title,aliases:e.aliases}));
 const identity=sha256hex(JSON.stringify({version:2,labels:labels.map(l=>({digest:sourceDigest(l.source),include:l.include})),evaluator:evaluator.identity,text,entities}));
 const directory=join(dirname(store),'inclusion-scores');mkdirSync(directory,{recursive:true,mode:0o700});
 return {identity,async score(source:Pick<InclusionSource,'title'|'body'>){
  const path=join(directory,sha256hex(identity+sourceDigest(source))+'.json');
  if(existsSync(path)){const value=JSON.parse(readFileSync(path,'utf8')).score;if(typeof value==='number'&&value>=0&&value<=1)return value;}
  const decision=await ruleEvaluator(root,store,undefined,teachingExamples(labels,source)).evaluate(text,entities,source);writeAtomic(path,JSON.stringify({score:decision.relevant}),0o600);return decision.relevant;
 }};
}
export async function decideInclusion(root:string,store:string,scope:string,text:string,source:Pick<InclusionSource,'title'|'body'>) {
 const policy=readInclusionPolicy(root,store,scope),evaluator=inclusionEvaluator(root,store,text,policy?.labels);
 if(policy&&(!policy.calibration||policy.text!==text||policy.calibration.identity!==evaluator.identity))throw Error('Review this inclusion rule again: its rule, entities, or model changed.');
 const label=policy?.labels.find(l=>sourceDigest(l.source)===sourceDigest(source));
 if(label)return label.include;
 const score=await evaluator.score(source);
 // Existing, unreviewed policies retain the earlier default until explicitly reviewed.
 return score>=(policy?.calibration?.threshold??.8);
}
