/** Read-only federation. Shared-only paths stay namespaced; a personal source's
 * opaque origin key links its shared copy back to the same local graph item. */
import {readConnections,connectionStorePath,sharedRequest,type SharedConnection} from './sharedConnections';
import {sourceKey} from './sharedRules';
import {readSourceInsertionLog,insertionEventRel,type SourceInsertion} from './insertionLog';
import {sharedProjection} from './sharedWorkspace';
import type {AssertionView} from './sharedVault';
import type {Graph} from './graph';
import {sourceInsertionMarkdown} from './sourceFeed';
import {sha256hex} from './hash';
import type {RecentEntry} from './viewTypes';
const remotePath=(c:SharedConnection,id:string)=>`shared/${c.id}/${id}.md`;
async function pages<T>(c:SharedConnection,kind:string):Promise<T[]>{const rows:T[]=[];let cursor:string|null=null;do{const p:{items:T[];next_cursor:string|null}=await sharedRequest(c,`/v1/${kind}?limit=200${cursor?'&cursor='+encodeURIComponent(cursor):''}`);rows.push(...p.items);cursor=p.next_cursor;}while(cursor);return rows;}
async function views(){const results=await Promise.allSettled(readConnections(connectionStorePath()).map(async c=>({c,view:sharedProjection(await pages<SourceInsertion>(c,'evidence'),await pages<AssertionView>(c,'assertions'))})));return results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);}
function localSources(root:string){return new Map(readSourceInsertionLog(root,{strict:true}).map(s=>['origin:'+sourceKey(s),s]));}
export async function unionGraph(root:string,graph:Graph):Promise<Graph>{
 if(!readConnections(connectionStorePath()).length)return graph;
 const local=localSources(root),paths=new Map(graph.nodes.flatMap(n=>[n.path,...(n.memberPaths??[])].filter((p):p is string=>!!p).map(p=>[p,n])));
 const nodes=graph.nodes.map(n=>({...n,vaults:['personal']})),byId=new Map(nodes.map(n=>[n.id,n])),edges=[...graph.edges];
 for(const {c,view} of await views()){
 const ids=new Map<string,string>();
 for(const n of view.graph.nodes){const source=view.sources.find(s=>'source:'+s.id===n.id),personal=source?local.get(source.source_id):undefined,existing=personal?paths.get(insertionEventRel(personal)):undefined;
 if(existing){ids.set(n.id,existing.id);byId.get(existing.id)!.vaults.push(c.id);continue;}
 const id=`shared:${c.id}:${n.id}`;ids.set(n.id,id);nodes.push({...n,id,path:remotePath(c,source?.id??n.id),vaults:[c.id]});}
 for(const e of view.graph.edges)edges.push({...e,source:ids.get(e.source)!,target:ids.get(e.target)!});
 }
 return {...graph,nodes,edges,hash:sha256hex(JSON.stringify([graph.hash,nodes.map(n=>[n.id,n.vaults]),edges]))};
}
export async function unionRecent(root:string,personal:RecentEntry[],offset:number,limit:number,total:number){
 const connections=readConnections(connectionStorePath());if(!connections.length)return {recent:personal.slice(offset,offset+limit),total,nextOffset:offset+limit<total?offset+limit:null};
 const local=localSources(root),extra:RecentEntry[]=[];
 for(const {c,view} of await views())for(const s of view.recent){const source=view.sources.find(x=>x.id===s.insertionId)!;if(local.has(source.source_id))continue;extra.push({...s,path:remotePath(c,s.insertionId),band:s.band??'person'});}
 const rows=[...personal,...extra].sort((a,b)=>b.modified-a.modified);return {recent:rows.slice(offset,offset+limit),total:total+extra.length,nextOffset:offset+limit<total+extra.length?offset+limit:null};
}
export async function unionSearch(root:string,q:string){
 if(!readConnections(connectionStorePath()).length)return [];
 const local=localSources(root),hits=[];
 for(const {c,view} of await views()){
 const results=await sharedRequest<{hits:{kind:string;id:string;text:string;snippet:string}[]}>(c,'/v1/search?q='+encodeURIComponent(q)+'&limit=50').catch(()=>({hits:[]}));
 for(const hit of results.hits){if(hit.kind!=='evidence')continue;const s=view.sources.find(s=>s.id===hit.id);if(!s||local.has(s.source_id))continue;hits.push({dir:'shared',note:{name:s.title,path:remotePath(c,s.id),modified:Date.parse((s as SourceInsertion&{submitted_at?:string}).submitted_at??'')||0,size:0},title:s.title,snippet:hit.snippet,band:'person' as const,from:c.name});}
 }return hits;
}
export async function unionNote(path:string){
 const m=/^shared\/([a-zA-Z0-9-]+)\/(ins_[a-f0-9]{24}|ent_[a-f0-9]{20})\.md$/.exec(path);if(!m)return null;
 const c=readConnections(connectionStorePath()).find(c=>c.id===m[1]);if(!c)return null;
 if(m[2]!.startsWith('ins_')){const s=await sharedRequest<SourceInsertion>(c,'/v1/evidence/'+m[2]);return {path,content:sourceInsertionMarkdown(s)};}
 const view=sharedProjection(await pages<SourceInsertion>(c,'evidence'),await pages<AssertionView>(c,'assertions'));
 const note=view.note(`projection/entities/${m[2]}.md`);if(!note)return null;
 return {...note,path,projectedEntity:note.projectedEntity?{...note.projectedEntity,assertions:note.projectedEntity.assertions.map(a=>({...a,entities:a.entities.map(e=>({...e,path:remotePath(c,e.id)})),sources:a.sources.map(s=>({...s,path:remotePath(c,s.insertion_id)}))}))}:undefined};
}
