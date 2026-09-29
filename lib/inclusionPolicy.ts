/** Durable, caller-scoped inclusion policies. No remote writes or provider calls. */
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {sha256hex} from './hash';
import {writeAtomic} from './fsx';
export interface InclusionSource {id:string;title:string;body:string;origin:string}
export interface InclusionLabel {source:InclusionSource;include:boolean}
export interface InclusionPolicy {version:string;scope:string;text:string;labels:InclusionLabel[];calibration?:{identity:string;threshold:number};updated:string}
export const integrationRuleScope=(name:string,account:string)=>JSON.stringify(['integration',name,account]);
export const sharedRuleScope=(id:string)=>JSON.stringify(['shared',id]);
export function inclusionPath(root:string,store:string,scope:string,draft=false){return join(dirname(store),'inclusion-rules',sha256hex(root),sha256hex(scope)+(draft?'.draft.json':'.json'));}
export function readInclusionPolicy(root:string,store:string,scope:string,draft=false):InclusionPolicy|undefined {const path=inclusionPath(root,store,scope,draft);return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;}
export function writeInclusionPolicy(root:string,store:string,policy:InclusionPolicy,draft=false){const path=inclusionPath(root,store,policy.scope,draft);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeAtomic(path,JSON.stringify(policy),0o600);}
export function sourceDigest(source:{title:string;body:string}){return sha256hex(JSON.stringify([source.title,source.body]));}
export function calibrateInclusion(rows:{include:boolean;score:number}[]) {
 const yes=rows.filter(r=>r.include).map(r=>r.score),no=rows.filter(r=>!r.include).map(r=>r.score);
 const remaining=Math.max(0,2-yes.length)+Math.max(0,2-no.length);
 if(remaining)return {ready:false,remaining,reason:'ratings' as const};
 const lower=Math.max(...no),upper=Math.min(...yes);
 if(upper-lower<.05)return {ready:false,remaining:0,reason:'overlap' as const};
 return {ready:true,remaining:0,reason:'ready' as const,threshold:(lower+upper)/2};
}

export function inclusionStatus(root:string,store:string,scope:string){const path=inclusionPath(root,store,scope)+'.status';return existsSync(path)?JSON.parse(readFileSync(path,'utf8')) as {error?:string;at:string}:undefined;}
export function writeInclusionStatus(root:string,store:string,scope:string,error?:string){writeAtomic(inclusionPath(root,store,scope)+'.status',JSON.stringify({error,at:new Date().toISOString()}),0o600);}
