/** Read-only federation. Shared-only paths stay namespaced; a personal source's
 * opaque origin key links its shared copy back to the same local graph item,
 * and an entity is one entity in every vault: its id is its name's (lib/ids.ts),
 * read through YOUR alias log, so a joined vault's "Ada" is your Ada.
 *
 * Every joined server is read from this computer's copy of it
 * (lib/serverStore.ts), never over the network: a read never waits on a
 * server, servers merge in the order of their ids, and one that has stopped
 * answering shows what it last said, with why, rather than dropping out (R8,
 * docs/plans/2026-10-12-stages-and-views-refactor.md). */
import {readConnections,connectionStorePath,type SharedConnection} from './sharedConnections';
import {readServer,serverBody,type ServerStatus} from './serverStore';
import {sourceKey} from './sharedRules';
import {readSourceInsertionLog,insertionEventRel,type SourceInsertion} from './insertionLog';
import {serverField,sharedProjection} from './sharedWorkspace';
import type {AssertionView} from './sharedVault';
import type {Graph} from './graph';
import {sourceInsertionMarkdown} from './sourceFeed';
import {sha256hex} from './hash';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {SHARED_AST_CITE,parseEntityId} from './ids';
import {edgeKey,seatLayout,type Positions} from './views/layout';
import {memoryTreeFiles} from './memoryTree';
import type {RecentEntry} from './viewTypes';
import {entityAliasResolver} from './assertionKinds';
import {assertionEntityPath,type ProjectedEntityAssertion,type ProjectedEntityView} from './assertionEntityView';
import {briefingEvidence} from './entityBriefing';
import {findNode} from './graphIdentity';
import type {BriefingRecord,NoteBriefingRequest} from './noteBriefing';
const remotePath=(c:SharedConnection,id:string)=>`shared/${c.id}/${id}.md`;
export {pages} from './serverStore';
export function vaultFilter(header: string | string[] | undefined): string[] { return typeof header === "string" ? [...new Set(header.split(",").filter(Boolean))] : []; }
export const includesPersonal = (filter: string[]) => !filter.length || filter.includes("personal");
/** Whether a read under `filter` is your vault's alone: nothing joined to merge. */
export const personalOnly = (filter: string[]) =>
  (filter.length === 1 && filter[0] === "personal") || (includesPersonal(filter) && !readConnections(connectionStorePath()).length);
type View=ReturnType<typeof sharedProjection>;
const cached=new Map<string,{head:number;view:View}>();
const EMPTY_VIEW=sharedProjection([],[]);
/** A server's projection as this computer holds it, rebuilt when the
 * follower has moved its head; empty before its first sync. */
export function viewOf(c:SharedConnection,store=connectionStorePath()):View{
 const {snapshot}=readServer(store,c.id);if(!snapshot)return EMPTY_VIEW;
 const hit=cached.get(c.id);if(hit?.head===snapshot.head)return hit.view;
 const view=sharedProjection(snapshot.evidence,snapshot.assertions as AssertionView[],snapshot.identities??[]);cached.set(c.id,{head:snapshot.head,view});return view;
}
/** How each joined server's copy stands: what a field shows beside it. */
export function serverStatuses(store=connectionStorePath()):(ServerStatus&{id:string;name:string})[]{
 return readConnections(store).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(c=>({...readServer(store,c.id).status,id:c.id,name:c.name}));
}
const connected=(id:string)=>{const c=readConnections(connectionStorePath()).find(x=>x.id===id);if(!c)throw Error('That server is no longer connected.');return c;};
/** One server's own field, as its window draws it (lib/sharedWorkspace.ts serverField), without `you`, opening through this vault's shared paths. */
export async function serverGraph(id:string,you?:Graph['userNote']):Promise<Graph>{
 const c=connected(id);
 const field=serverField(viewOf(c),you);
 return {...field,nodes:field.nodes.map(n=>({...n,path:remotePath(c,n.id.replace(/^source:/,'')),vaults:[c.id]}))};
}
/** A briefing on one server's own field (lib/noteBriefing.ts): its claims
 * and notes alone, without you, as serverGraph draws it. A selected note's
 * text is fetched whole; the list of a server's notes carries no bodies. */
export async function serverBriefingRecord(id:string,request:NoteBriefingRequest,you?:Graph['userNote']):Promise<BriefingRecord>{
 const c=connected(id);
 const view=viewOf(c),graph={...await serverGraph(id,you),...(you?{userNote:you}:{})};
 const node=(key:string)=>graph.nodes[findNode(graph.nodes,key)],bodies=new Map<string,string>();
 for(const key of typeof request==='string'?[request]:request.selected){const n=node(key);if(n?.group==='source')bodies.set(n.id,serverBody(connectionStorePath(),c.id,n.id.slice('source:'.length))??'');}
 return {graph,connections:()=>view.connections,item:key=>{
  const n=node(key);if(!n?.path)throw Error('This note is not available for a briefing.');
  const entity=n.entity?view.note(assertionEntityPath(n.id))?.projectedEntity:undefined;
  const text=entity?briefingEvidence(entity as ProjectedEntityView).map(a=>`${a.created_at} (${a.confidence}) ${a.text}`).join('\n'):bodies.get(n.id)??'';
  return {id:n.id,path:n.path,title:n.title,kind:n.entity?'entity':'source',text:text.slice(0,16_000),revision:sha256hex(text)};
 }};
}
/** The joined servers a read merges, in the order of their ids, each as this computer holds it. */
function views(filter: string[] = []){return readConnections(connectionStorePath()).filter(c=>!filter.length||filter.includes(c.id)).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(c=>({c,view:viewOf(c)}));}
function localSources(root:string){return new Map(readSourceInsertionLog(root,{strict:true}).map(s=>['origin:'+sourceKey(s),s]));}
/** Each memory topic's citations of joined vaults' claims, by path. */
function sharedCitations(root:string){const cited=new Map<string,[string,string][]>();if(!existsSync(join(root,'memory')))return cited;for(const f of memoryTreeFiles(root))cited.set(`memory/${f}`,[...readFileSync(join(root,'memory',f),'utf8').matchAll(SHARED_AST_CITE)].map(m=>[m[1]!,m[2]!]));return cited;}
/** The union seated: your nodes where your field seats them, every other
 * node seated around them by when it arrived on its server. */
function seatedAround(graph:Graph,arrivals:ReadonlyMap<string,string>):Graph{
 const fixed:Positions={};
 for(const n of graph.nodes)if(Number.isFinite(n.x)&&Number.isFinite(n.y))fixed[n.id]=[n.x!,n.y!];
 const at=seatLayout(graph,arrivals,fixed);
 return {...graph,nodes:graph.nodes.map(n=>({...n,x:at[n.id]![0],y:at[n.id]![1]}))};
}
export async function unionGraph(root:string,graph:Graph,filter:string[] = []):Promise<Graph>{
 const personalGraph=graph;
 const localPaths=new Map(personalGraph.nodes.flatMap(n=>[n.path,...(n.memberPaths??[])].filter((p):p is string=>!!p).map(p=>[p,n])));
 const remoteCopies=new Map<string,string[]>();
 if(!includesPersonal(filter)) graph = {...graph,nodes:[],edges:[]};
 if(filter.length===1&&filter[0]==="personal")return graph;
 if(!readConnections(connectionStorePath()).length)return graph;
 const local=localSources(root),cites=sharedCitations(root),citing=new Set<string>(),drawn=new Set<string>(),paths=new Map(graph.nodes.flatMap(n=>[n.path,...(n.memberPaths??[])].filter((p):p is string=>!!p).map(p=>[p,n])));
 const nodes=graph.nodes.map(n=>({...n,vaults:['personal']})),byId=new Map(nodes.map(n=>[n.id,n])),edges=graph.edges.map(e=>({...e}));
 // One entity across vaults: keyed by the id it resolves to here, it is your
 // node when you have one, else the first joined vault's, and every other
 // vault's mentions land on it. A node's degree counts each tie once, however
 // many vaults draw it; one drawn twice is a heavier thread.
 const resolveEntity=entityAliasResolver(root),entityAt=new Map<string,typeof nodes[number]>(nodes.filter(n=>n.entity).map(n=>[n.id,n]));
 const pair=(a:string,b:string)=>a<b?a+'\0'+b:b+'\0'+a,edgeAt=new Map(edges.map(e=>[pair(e.source,e.target),e])),madeBy=new Map<string,string>();
 // When each server's part arrived: server by server in the order of their
 // ids, each by its own clock (lib/views/layout.ts seatLayout).
 const arrivals=new Map<string,string>();
 for(const [k,{c,view}] of views(filter).entries()){
 const ids=new Map<string,string>(),when=(key:string)=>`${String(k).padStart(4,'0')}\u0000${view.arrivals.get(key)??''}`;
 for(const n of view.graph.nodes){const source=view.sources.find(s=>'source:'+s.id===n.id),personal=source?local.get(source.source_id):undefined,existing=personal?paths.get(insertionEventRel(personal)):undefined;
 if(existing){ids.set(n.id,existing.id);byId.get(existing.id)!.vaults.push(c.id);continue;}
 const entityId=n.entity?resolveEntity({id:parseEntityId(n.id),label:n.title}).id:undefined,same=entityId?entityAt.get(entityId):undefined;
 if(same){ids.set(n.id,same.id);if(!same.vaults.includes(c.id))same.vaults.push(c.id);continue;}
 const id=`shared:${c.id}:${n.id}`;ids.set(n.id,id);madeBy.set(id,c.id);
 const localNode=personal?localPaths.get(insertionEventRel(personal)):undefined;
 if(localNode)remoteCopies.set(localNode.id,[...(remoteCopies.get(localNode.id)??[]),id]);
 const made={...n,id,path:remotePath(c,source?.id??n.id),vaults:[c.id]};nodes.push(made);arrivals.set(id,when(n.id));byId.set(id,made);if(entityId)entityAt.set(entityId,made);}
 for(const e of view.graph.edges){const source=ids.get(e.source)!,target=ids.get(e.target)!,key=pair(source,target),seen=edgeAt.get(key);
  if(seen){seen.weight=(seen.weight??1)+1;continue;}
  const edge={...e,source,target};edgeAt.set(key,edge);edges.push(edge);arrivals.set(edgeKey(source,target),when(edgeKey(e.source,e.target)));
  // this vault's projection already counted it on the nodes it made
  for(const end of [source,target])if(madeBy.get(end)!==c.id){const node=byId.get(end);if(node)node.degree++;}}
 // A memory folded from this vault's claims stands beside their entities.
 for(const m of personalGraph.nodes)if(m.group==='memory'&&m.path)for(const [vault,ast] of cites.get(m.path)??[]){
  if(vault!==c.id)continue;
  for(const e of view.assertions.find(a=>a.id===ast)?.entities??[]){const target=ids.get(e.id);if(!target)continue;const key=pair(m.id,target);if(!drawn.has(key)&&!edgeAt.has(key)){drawn.add(key);const edge={source:m.id,target};edgeAt.set(key,edge);edges.push(edge);citing.add(m.id);}}
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
 const servers=serverStatuses().filter(s=>!filter.length||filter.includes(s.id));
 return {...seatedAround({...graph,nodes,edges,hash:sha256hex(JSON.stringify([graph.hash,nodes.map(n=>[n.id,n.vaults]),edges,servers.map(s=>[s.id,s.head,!!s.error])]))},arrivals),servers};
}
export async function unionRecent(root:string,personal:RecentEntry[],offset:number,limit:number,total:number,filter:string[] = []){
 if(!includesPersonal(filter)){personal=[];total=0;}
 const connections=readConnections(connectionStorePath());if(!connections.length)return {recent:personal.slice(offset,offset+limit),total,nextOffset:offset+limit<total?offset+limit:null};
 const local=localSources(root),extra:RecentEntry[]=[];
 for(const {c,view} of views(filter))for(const s of view.recent){const source=view.sources.find(x=>x.id===s.insertionId)!;if(includesPersonal(filter)&&local.has(source.source_id))continue;extra.push({...s,path:remotePath(c,s.insertionId),band:s.band??'person'});}
 const rows=[...personal,...extra].sort((a,b)=>b.modified-a.modified);return {recent:rows.slice(offset,offset+limit),total:total+extra.length,nextOffset:offset+limit<total+extra.length?offset+limit:null};
}
/** A joined server's landings whose title and text hold every word of `q`, as this computer holds them. */
export function serverMatches(c:SharedConnection,view:View,q:string,limit=50):{source:SourceInsertion&{submitted_at?:string};snippet:string}[]{
 const words=q.toLocaleLowerCase().split(/\s+/u).filter(Boolean),out:{source:SourceInsertion&{submitted_at?:string};snippet:string}[]=[];
 if(!words.length)return out;
 for(const s of view.sources){
  if(out.length>=limit)break;
  const body=serverBody(connectionStorePath(),c.id,s.id)??'',text=`${s.title}\n${body}`.toLocaleLowerCase();
  if(!words.every(w=>text.includes(w)))continue;
  const at=Math.max(0,body.toLocaleLowerCase().indexOf(words[0]!)-80);
  out.push({source:s as SourceInsertion&{submitted_at?:string},snippet:body.slice(at,at+240).replace(/\s+/gu,' ')});
 }
 return out;
}
export async function unionSearch(root:string,q:string,filter:string[] = []){
 if(!readConnections(connectionStorePath()).length)return [];
 const local=localSources(root),hits=[];
 for(const {c,view} of views(filter))
  for(const {source:s,snippet} of serverMatches(c,view,q)){if(includesPersonal(filter)&&local.has(s.source_id))continue;hits.push({dir:'shared',note:{name:s.title,path:remotePath(c,s.id),modified:Date.parse(s.submitted_at??'')||0,size:0},title:s.title,snippet,band:'person' as const,from:c.name});}
 return hits;
}
export async function unionNote(path:string){
 const m=/^shared\/([a-zA-Z0-9-]+)\/(ins_[a-f0-9]{24}|ent_[a-f0-9]{20})\.md$/.exec(path);if(!m)return null;
 const c=readConnections(connectionStorePath()).find(c=>c.id===m[1]);if(!c)return null;
 const view=viewOf(c);
 if(m[2]!.startsWith('ins_')){const s=view.sources.find(x=>x.id===m[2]);if(!s)return null;return {path,content:sourceInsertionMarkdown({...s,body:serverBody(connectionStorePath(),c.id,s.id)??''} as SourceInsertion)};}
 const note=view.note(`projection/entities/${m[2]}.md`);if(!note)return null;
 return {...note,path,projectedEntity:note.projectedEntity?{...note.projectedEntity,assertions:note.projectedEntity.assertions.map(a=>remoteAssertion(c,a))}:undefined};
}
type SharedRow=NonNullable<NonNullable<ReturnType<ReturnType<typeof sharedProjection>['note']>>['projectedEntity']>['assertions'][number];
/** A joined vault's claim, its links pointed at that vault and marked with it. */
const remoteAssertion=(c:SharedConnection,a:SharedRow)=>({...a,entities:a.entities.map(e=>({...e,path:remotePath(c,e.id)})),sources:a.sources.map(s=>({...s,path:remotePath(c,s.insertion_id)})),vault:{id:c.id,name:c.name}});
/** What the joined vaults claim about each of `ids` (entity ids as this vault
 * resolves them), so opening an entity reads every vault's claims about it,
 * each marked with its vault, as this computer holds them. */
export async function sharedEntityClaims(root:string,ids:readonly string[],filter:string[] = []):Promise<Map<string,ProjectedEntityAssertion[]>>{
 const out=new Map<string,ProjectedEntityAssertion[]>();
 if(!ids.length||!readConnections(connectionStorePath()).length)return out;
 const want=new Set(ids),resolve=entityAliasResolver(root);
 for(const {c,view} of views(filter)){
  const named=new Map(view.assertions.flatMap(a=>a.entities).map(e=>[e.id,e]));
  for(const e of named.values()){const id=resolve(e).id;if(!want.has(id))continue;
   const rows=out.get(id)??[],seen=new Set(rows.map(r=>r.id));
   for(const a of view.note(`projection/entities/${e.id}.md`)?.projectedEntity?.assertions??[])if(!seen.has(a.id)){seen.add(a.id);rows.push(remoteAssertion(c,a) as unknown as ProjectedEntityAssertion);}
   out.set(id,rows);}
 }
 return out;
}
