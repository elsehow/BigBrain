/** Local contribution controller. Source logs are read-only; config and evaluation
 * receipts live beside local credentials, outside both personal and shared vaults. */
import {existsSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {writeAtomic} from './fsx';
import {sha256hex} from './hash';
import {readSourceInsertionLog,type SourceInsertion} from './insertionLog';
import {readConnections,sharedRequest,type SharedConnection} from './sharedConnections';
import {decideInclusion} from './inclusionEvaluation';
import {sharedRuleScope} from './inclusionPolicy';
import {ruleEvaluator} from './sharedRuleEvaluator';
import {resolveRuleMentions,ruleCandidateFilter} from './sharedRuleMentions';
interface Rule {root?:string;text:string;version:string;created:string;seen:string[];error?:string;lastRun?:string}
type Config=Record<string,Rule>;
export interface Contribution {path?:string;id:string;source_id:string;title:string;insertion_id:string;status:string;version:number;added_at:string;other_contributors:string[]}
const configs=(store:string):Config=>existsSync(store+'.rules.json')?JSON.parse(readFileSync(store+'.rules.json','utf8')):{};
const save=(store:string,c:Config)=>writeAtomic(store+'.rules.json',JSON.stringify(c),0o600);
export const getRule=(store:string,id:string)=>configs(store)[id]??null;
export function setRule(store:string,id:string,text:unknown,root:string) {
 const c=configs(store);
 if(text===null)delete c[id];
 else {if(typeof text!=='string'||!text.trim()||text.length>4000)throw Error('Rule must be 1–4000 characters');resolveRuleMentions(root,text);c[id]={root,text:text.trim(),version:randomUUID(),created:new Date().toISOString(),seen:[]};}
 save(store,c);return c[id]??null;
}
export const sourceKey=(s:SourceInsertion)=>'personal-'+sha256hex(s.source_id).slice(0,40);
function sources(root:string) {
 const latest=new Map<string,SourceInsertion>();
 for(const s of readSourceInsertionLog(root,{strict:true}))latest.set(s.source_id,s);
 return [...latest.values()];
}
export async function contributions(c:SharedConnection):Promise<Contribution[]> { return (await sharedRequest<{items:Contribution[]}>(c,'/v1/contributions')).items; }
const locks=new Set<string>();
export interface TestRow {id:string;title:string;date:string;status:string;contribution?:Contribution}
export interface TestResult {id:string;connection:string;text:string;since:string;rows:TestRow[];scanned:number;complete:boolean;error?:string;created:number;sourceIds:string[]}
const tests=new Map<string,TestResult>();
export function getTest(id:string,connection:string){const t=tests.get(id);return t?.connection===connection?t:undefined;}
function publicTest(t:TestResult){const {sourceIds:_,...view}=t;return view;}
export const testView=(id:string,connection:string)=>{const t=getTest(id,connection);return t?publicTest(t):null;};
async function classify(root:string,store:string,text:string,batch:SourceInsertion[],connection:string):Promise<string[]> {
 const ids:string[]=[];for(const source of batch)if(await decideInclusion(root,store,sharedRuleScope(connection),text,source))ids.push(source.id);return ids;
}
async function* batches(rows:SourceInsertion[]) {
 let batch:SourceInsertion[]=[],size=0;
 for(const s of rows){const n=s.body.length+s.title.length;if(n>180000){if(batch.length)yield batch;batch=[];size=0;yield [s];continue;}if(size+n>180000||batch.length>=12){yield batch;batch=[];size=0;}batch.push(s);size+=n;}if(batch.length)yield batch;
}
export function startTest(root:string,store:string,c:SharedConnection,text:unknown,since:unknown) {
 if(typeof text!=='string'||!text.trim()||text.length>4000)throw Error('Write an inclusion rule first');
 if(typeof since!=='string'||(since&&!/^\d{4}-\d{2}-\d{2}$/.test(since)))throw Error('Invalid date');
 if([...tests.values()].some(t=>t.connection===c.id&&!t.complete))throw Error('A test is already running');
 for(const [id,t] of tests)if(t.complete&&Date.now()-t.created>3600000)tests.delete(id);
 resolveRuleMentions(root,text);ruleEvaluator(root,store);
 const t:TestResult={id:randomUUID(),connection:c.id,text:text.trim(),since,rows:[],scanned:0,complete:false,created:Date.now(),sourceIds:[]};tests.set(t.id,t);
 void (async()=>{try{
 const existing=await contributions(c),bySource=new Map(existing.map(x=>[x.source_id,x]));
 const candidates=sources(root).filter(s=>!since||(s.received_at??s.occurred_at??'')>=since).filter(ruleCandidateFilter(root,t.text));
 const groups=batches(candidates);
 const pending:SourceInsertion[][]=[];for await(const batch of groups)pending.push(batch);
 const results: {batch:SourceInsertion[];selected:Set<string>}[]=[];
 let next=0;
 await Promise.all(Array.from({length:3},async()=>{while(next<pending.length){const batch=pending[next++]!;const selected=new Set(await classify(root,store,t.text,batch,c.id));results.push({batch,selected});t.scanned+=batch.length;}}));
 for(const {batch,selected} of results)for(const s of batch){if(!selected.has(s.id))continue;const contribution=bySource.get('origin:'+sourceKey(s));t.sourceIds.push(s.id);t.rows.push({id:s.id,title:s.title,date:s.received_at??s.occurred_at??'',status:contribution?.status??'new',contribution});}

 }catch(e){t.error=e instanceof Error?e.message:String(e)}finally{t.complete=true;}})();return publicTest(t);
}
async function sendSources(store:string,c:SharedConnection,rows:SourceInsertion[]) {
 let added=0;
 // Batches remain under the server's whole-request byte bound.
 let batch:unknown[]=[],batchSources:SourceInsertion[]=[],bytes=0;
 const flush=async()=>{if(!batch.length)return;const r=await sharedRequest<{results:{ok:boolean;id?:string;error?:string}[]}>(c,'/v1/evidence/batch',{items:batch});const file=store+'.receipts.json';const receipts:Record<string,unknown>=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
 for(let i=0;i<r.results.length;i++){const item=r.results[i]!,source=batchSources[i]!;if(item.ok){receipts[c.id+':'+source.id]={connection:c.id,personal_source_id:source.source_id,personal_insertion_id:source.id,content_sha256:source.content_sha256,shared_source_id:'origin:'+sourceKey(source),shared_insertion_id:item.id,contributed_at:new Date().toISOString()};added++;}}
 writeAtomic(file,JSON.stringify(receipts),0o600);
 const failed=r.results.find(x=>!x.ok);if(failed)throw Error(failed.error??'Contribution failed');batch=[];batchSources=[];bytes=0;};
 for(const s of rows){const item={title:s.title,body:s.body,origin:{id:sourceKey(s),author:s.author.id,kind:'note'}};const size=Buffer.byteLength(JSON.stringify(item));if(size>16*1024*1024)throw Error('A source exceeds the shared vault size limit (16 MiB)');if(bytes+size>1000000||batch.length>=20)await flush();batch.push(item);batchSources.push(s);bytes+=size;}await flush();return added;
}
export async function importTest(root:string,store:string,c:SharedConnection,id:string,selected:unknown) {
 const t=getTest(id,c.id);if(!t||!t.complete||t.error||Date.now()-t.created>3600000)throw Error('Run a complete test before importing');
 if(!Array.isArray(selected)||selected.some(x=>typeof x!=='string'||!t.sourceIds.includes(x)))throw Error('Choose sources from this test');
 const existing=await contributions(c),blocked=new Set(existing.map(x=>x.source_id));
 const ids=new Set(selected),rows=sources(root).filter(s=>ids.has(s.id)&&!blocked.has('origin:'+sourceKey(s)));
 return {added:await sendSources(store,c,rows)};
}
export async function tickRules(root:string,store:string) {
 if(locks.has(store))return;locks.add(store);
 try{for(const c of readConnections(store)){
 const rule=getRule(store,c.id);if(!rule||rule.root!==root)continue;
 try{
 const existing=await contributions(c),blocked=new Set(existing.map(x=>x.source_id));
 const seen=new Set(rule.seen);
 // Saving covers future arrivals; old matches require an explicit test/import.
 const fresh=sources(root).filter(s=>!seen.has(s.id)&&(s.received_at??'')>=rule.created);
 const groups=batches(fresh.filter(ruleCandidateFilter(root,rule.text)));
 for await(const batch of groups){const ids=new Set(await classify(root,store,rule.text,batch,c.id));if(getRule(store,c.id)?.version!==rule.version)break;await sendSources(store,c,batch.filter(s=>ids.has(s.id)&&!blocked.has('origin:'+sourceKey(s))));batch.forEach(s=>seen.add(s.id));}
 const config=configs(store);if(config[c.id]?.version===rule.version){config[c.id]={...rule,seen:[...seen],error:undefined,lastRun:new Date().toISOString()};save(store,config);}
 }catch(e){const config=configs(store);if(config[c.id]?.version===rule.version){config[c.id]!.error=e instanceof Error?e.message:String(e);save(store,config);}}
 }}finally{locks.delete(store);}
}
