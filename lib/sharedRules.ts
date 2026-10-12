/** Contributing personal notes to a server. Source logs are read-only; receipts live
 * beside the local credentials, outside both personal and shared vaults. What to
 * contribute is decided by lenses (lib/lensSync.ts). */
import {existsSync,readFileSync} from 'node:fs';
import {writeAtomic} from './fsx';
import {sha256hex} from './hash';
import type {SourceInsertion} from './insertionLog';
import {SharedConnectionError,sharedRequest,type SharedConnection} from './sharedConnections';
export interface Contribution {path?:string;id:string;source_id:string;title:string;insertion_id:string;status:string;version:number;added_at:string;other_contributors:string[]}

/** A server's inclusion rule from before lenses, read once to become a lens (lib/lensSync.ts migrateRules). */
interface LegacyRule {root?:string;text:string}
const rulesPath=(store:string)=>store+'.rules.json';
const legacyRules=(store:string):Record<string,LegacyRule>=>existsSync(rulesPath(store))?JSON.parse(readFileSync(rulesPath(store),'utf8')):{};
export const getRule=(store:string,id:string):LegacyRule|null=>legacyRules(store)[id]??null;
export function dropRule(store:string,id:string){const rules=legacyRules(store);delete rules[id];writeAtomic(rulesPath(store),JSON.stringify(rules),0o600);}

/** A personal note's id on a server: the same for every server, opaque to them. */
export const sourceKey=(s:Pick<SourceInsertion,'source_id'>)=>'personal-'+sha256hex(s.source_id).slice(0,40);
const STATUSES=new Set(['active','withdrawn']);
const readable=(x:unknown)=>{const r=x as Record<string,unknown>|null;return !!r&&typeof r.id==='string'&&typeof r.source_id==='string'&&typeof r.insertion_id==='string'&&STATUSES.has(r.status as string);};
/** Your contributions on a server. A reply this app can't read is refused, never guessed at: publishing retracts every claim whose sources it doesn't list as active. */
export async function contributions(c:SharedConnection):Promise<Contribution[]> {
 const {items}=await sharedRequest<{items:unknown}>(c,'/v1/contributions');
 if(!Array.isArray(items)||!items.every(readable))throw new SharedConnectionError(502,'The server sent a list of contributions this app can’t read.');
 return items as Contribution[];
}
export async function sendSources(store:string,c:SharedConnection,rows:SourceInsertion[]) {
 let added=0;
 // Batches remain under the server's whole-request byte bound.
 let batch:unknown[]=[],batchSources:SourceInsertion[]=[],bytes=0;
 const flush=async()=>{if(!batch.length)return;const r=await sharedRequest<{results:{ok:boolean;id?:string;error?:string}[]}>(c,'/v1/evidence/batch',{items:batch});const file=store+'.receipts.json';const receipts:Record<string,unknown>=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
 for(let i=0;i<r.results.length;i++){const item=r.results[i]!,source=batchSources[i]!;if(item.ok){receipts[c.id+':'+source.id]={connection:c.id,personal_source_id:source.source_id,personal_insertion_id:source.id,content_sha256:source.content_sha256,shared_source_id:'origin:'+sourceKey(source),shared_insertion_id:item.id,contributed_at:new Date().toISOString()};added++;}}
 writeAtomic(file,JSON.stringify(receipts),0o600);
 const failed=r.results.find(x=>!x.ok);if(failed)throw Error(failed.error??'Contribution failed');batch=[];batchSources=[];bytes=0;};
 for(const s of rows){const item={title:s.title,body:s.body,origin:{id:sourceKey(s),author:s.author.id,kind:'note'}};const size=Buffer.byteLength(JSON.stringify(item));if(size>16*1024*1024)throw Error('A source exceeds the shared vault size limit (16 MiB)');if(bytes+size>1000000||batch.length>=20)await flush();batch.push(item);batchSources.push(s);bytes+=size;}await flush();return added;
}
