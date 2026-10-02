import { sharedGraphLayout } from './sharedGraphLayout';
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
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {SHARED_AST_CITE} from './ids';
import {memoryTreeFiles} from './memoryTree';
import type {RecentEntry} from './viewTypes';
const remotePath=(c:SharedConnection,id:string)=>`shared/${c.id}/${id}.md`;
async function pages<T>(c:SharedConnection,kind:string):Promise<T[]>{const rows:T[]=[];let cursor:string|null=null;do{const p:{items:T[];next_cursor:string|null}=await sharedRequest(c,`/v1/${kind}?limit=200${cursor?'&cursor='+encodeURIComponent(cursor):''}`);rows.push(...p.items);cursor=p.next_cursor;}while(cursor);return rows;}
export function vaultFilter(header: string | string[] | undefined): string[] { return typeof header === "string" ? [...new Set(header.split(",").filter(Boolean))] : []; }
export const includesPersonal = (filter: string[]) => !filter.length || filter.includes("personal");
async function views(filter: string[] = []){const results=await Promise.allSettled(readConnections(connectionStorePath()).filter(c => !filter.length || filter.includes(c.id)).map(async c=>({c,view:sharedProjection(await pages<SourceInsertion>(c,'evidence'),await pages<AssertionView>(c,'assertions'))})));return results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);}
function localSources(root:string){return new Map(readSourceInsertionLog(root,{strict:true}).map(s=>['origin:'+sourceKey(s),s]));}
/** Each memory topic's citations of joined vaults' claims, by path. */
function sharedCitations(root:string){const cited=new Map<string,[string,string][]>();if(!existsSync(join(root,'memory')))return cited;for(const f of memoryTreeFiles(root))cited.set(`memory/${f}`,[...readFileSync(join(root,'memory',f),'utf8').matchAll(SHARED_AST_CITE)].map(m=>[m[1]!,m[2]!]));return cited;}
export async function unionGraph(root:string,graph:Graph,filter:string[] = []):Promise<Graph>{
 const personalGraph=graph;
 const localPaths=new Map(personalGraph.nodes.flatMap(n=>[n.path,...(n.memberPaths??[])].filter((p):p is string=>!!p).map(p=>[p,n])));
 const remoteCopies=new Map<string,string[]>();
 if(!includesPersonal(filter)) graph = {...graph,nodes:[],edges:[]};
 if(filter.length===1&&filter[0]==="personal")return graph;
 if(!readConnections(connectionStorePath()).length)return graph;
 const local=localSources(root),cites=sharedCitations(root),citing=new Set<string>(),drawn=new Set<string>(),paths=new Map(graph.nodes.flatMap(n=>[n.path,...(n.memberPaths??[])].filter((p):p is string=>!!p).map(p=>[p,n])));
 const nodes=graph.nodes.map(n=>({...n,vaults:['personal']})),byId=new Map(nodes.map(n=>[n.id,n])),edges=[...graph.edges];
 for(const {c,view} of await views(filter)){
 const ids=new Map<string,string>();
 for(const n of view.graph.nodes){const source=view.sources.find(s=>'source:'+s.id===n.id),personal=source?local.get(source.source_id):undefined,existing=personal?paths.get(insertionEventRel(personal)):undefined;
 if(existing){ids.set(n.id,existing.id);byId.get(existing.id)!.vaults.push(c.id);continue;}
 const id=`shared:${c.id}:${n.id}`;ids.set(n.id,id);
 const localNode=personal?localPaths.get(insertionEventRel(personal)):undefined;
 if(localNode)remoteCopies.set(localNode.id,[...(remoteCopies.get(localNode.id)??[]),id]);nodes.push({...n,id,path:remotePath(c,source?.id??n.id),vaults:[c.id]});}
 for(const e of view.graph.edges)edges.push({...e,source:ids.get(e.source)!,target:ids.get(e.target)!});
 // A memory folded from this vault's claims stands beside their entities.
 for(const m of personalGraph.nodes)if(m.group==='memory'&&m.path)for(const [vault,ast] of cites.get(m.path)??[]){
  if(vault!==c.id)continue;
  for(const e of view.assertions.find(a=>a.id===ast)?.entities??[]){const target=ids.get(e.id),key=m.id+'\0'+target;if(target&&!drawn.has(key)){drawn.add(key);edges.push({source:m.id,target});citing.add(m.id);}}
 }
 }
 if(!includesPersonal(filter)){
  const memories=new Map(personalGraph.nodes.filter(n=>n.group==='memory').map(n=>[n.id,n]));
  const connected=new Set<string>();
  for(const edge of personalGraph.edges){
   const memory=memories.get(edge.source)??memories.get(edge.target);
   if(!memory)continue;
   const other=memory.id===edge.source?edge.target:edge.source;
   for(const remote of remoteCopies.get(other)??[]){connected.add(memory.id);edges.push({...edge,source:memory.id,target:remote});}
  }
  for(const id of citing)connected.add(id);
  for(const id of connected)nodes.push({...memories.get(id)!,vaults:['personal']});
 }
 return sharedGraphLayout({...graph,nodes,edges,hash:sha256hex(JSON.stringify([graph.hash,nodes.map(n=>[n.id,n.vaults]),edges]))});
}
export async function unionRecent(root:string,personal:RecentEntry[],offset:number,limit:number,total:number,filter:string[] = []){
 if(!includesPersonal(filter)){personal=[];total=0;}
 const connections=readConnections(connectionStorePath());if(!connections.length)return {recent:personal.slice(offset,offset+limit),total,nextOffset:offset+limit<total?offset+limit:null};
 const local=localSources(root),extra:RecentEntry[]=[];
 for(const {c,view} of await views(filter))for(const s of view.recent){const source=view.sources.find(x=>x.id===s.insertionId)!;if(includesPersonal(filter)&&local.has(source.source_id))continue;extra.push({...s,path:remotePath(c,s.insertionId),band:s.band??'person'});}
 const rows=[...personal,...extra].sort((a,b)=>b.modified-a.modified);return {recent:rows.slice(offset,offset+limit),total:total+extra.length,nextOffset:offset+limit<total+extra.length?offset+limit:null};
}
export async function unionSearch(root:string,q:string,filter:string[] = []){
 if(!readConnections(connectionStorePath()).length)return [];
 const local=localSources(root),hits=[];
 for(const {c,view} of await views(filter)){
 const results=await sharedRequest<{hits:{kind:string;id:string;text:string;snippet:string}[]}>(c,'/v1/search?q='+encodeURIComponent(q)+'&limit=50').catch(()=>({hits:[]}));
 for(const hit of results.hits){if(hit.kind!=='evidence')continue;const s=view.sources.find(s=>s.id===hit.id);if(!s||(includesPersonal(filter)&&local.has(s.source_id)))continue;hits.push({dir:'shared',note:{name:s.title,path:remotePath(c,s.id),modified:Date.parse((s as SourceInsertion&{submitted_at?:string}).submitted_at??'')||0,size:0},title:s.title,snippet:hit.snippet,band:'person' as const,from:c.name});}
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
