import {parseEnvelope} from './envelope';
import {includesEverything} from './inclusionMode';
/** Synchronous guard so gardener admission cannot bypass a reviewed policy. */
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {sha256hex} from './hash';
import {writeAtomic} from './fsx';
import {inclusionEvaluator} from './inclusionEvaluation';
import {readInclusionPolicy} from './inclusionPolicy';
import type {StagedItem} from './stageStorage';
const path=(root:string,store:string,scope:string,item:StagedItem)=>join(dirname(store),'inclusion-permits',sha256hex(JSON.stringify([root,scope,item.id,item.content]))+'.json');
export function recordInclusionPermit(root:string,store:string,scope:string,version:string,text:string,item:StagedItem,include:boolean){writeAtomic(path(root,store,scope,item),JSON.stringify({version,text,include}),0o600);}
export function inclusionPermit(root:string,store:string,scope:string,text:string,item:StagedItem,include:boolean){
 if(includesEverything(text))return include && (item.source!=='granola'||parseEnvelope(item.content).envelope.format==='granola-transcript-v1');
 const policy=readInclusionPolicy(root,store,scope);if(!policy)return true;
 if(!policy.calibration||policy.calibration.identity!==inclusionEvaluator(root,store,text,policy.labels).identity)return false;
 const file=path(root,store,scope,item);if(!existsSync(file))return false;
 const permit=JSON.parse(readFileSync(file,'utf8'));return policy.text===text&&permit.text===text&&permit.version===policy.version&&permit.include===include;
}
