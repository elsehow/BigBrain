/**
 * lensSync.ts — keeping lenses, and the servers they are shared with, in step.
 *
 * Every tick, each lens is scored over the whole vault (lib/lensScoring.ts;
 * cached scores make that cheap once paid) and its membership recomputed
 * (lib/lenses.ts). What changed is applied:
 *
 *   - A note that newly matches a shared lens joins it. Typing the lens's
 *     name to share it consented to future matches (decision D2); each one
 *     adds a "shared" event for the feed.
 *   - A note that stops matching leaves. Shrinking what is shared is always
 *     safe.
 *   - A change nobody made to the lens (a model upgrade, the vault's entities,
 *     or this update's move from server rules to lenses) that would add notes
 *     to a shared lens opens a review (decision D3). In Conservative mode, and
 *     always after the update, the lens takes no additions until someone
 *     says it looks OK. In Yee-haw mode the notes join and the review stays
 *     as a warning.
 *
 * Then each server is given the union of the members of the lenses shared
 * with it: missing notes are contributed or restored, and notes no lens wants
 * any more are withdrawn. Only what lenses contributed is ever withdrawn
 * (`lens-shares.json`); anything else a member put on a server stays.
 */
import {existsSync,mkdirSync,readFileSync,rmSync,appendFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeAtomic} from './fsx';
import {sha256hex} from './hash';
import {readConnections,sharedRequest,SharedConnectionError,type SharedConnection} from './sharedConnections';
import {contributions,dropRule,getRule,sendSources,sourceKey,type Contribution} from './sharedRules';
import {inclusionPath,readInclusionPolicy,sharedRuleScope} from './inclusionPolicy';
import {listLenses,membership,newLens,readLens,sharingMode,writeLens,type Lens,type LensReview} from './lenses';
import {lensNotes,scorePass,type PassOptions} from './lensScoring';

/** Server writes per connection per tick: under the door's 60 a minute per credential. */
const WRITE_BUDGET=25;

// ── what lenses put on each server ──────────────────────────────────────────
type Shares=Record<string,string[]>;
const sharesPath=(store:string)=>join(dirname(store),'lens-shares.json');
const readShares=(store:string):Shares=>existsSync(sharesPath(store))?JSON.parse(readFileSync(sharesPath(store),'utf8')):{};
function recordShares(store:string,connection:string,add:string[],remove:string[]=[]){
 const all=readShares(store),mine=new Set(all[connection]??[]);
 for(const o of add)mine.add(o);for(const o of remove)mine.delete(o);
 all[connection]=[...mine];mkdirSync(dirname(sharesPath(store)),{recursive:true,mode:0o700});writeAtomic(sharesPath(store),JSON.stringify(all),0o600);
}
/** A personal note's id on a server: its origin key (lib/sharedRules.ts). */
export const originOf=(sourceId:string)=>'origin:'+sourceKey({source_id:sourceId});

// ── events for the feed ─────────────────────────────────────────────────────
export interface LensEvent {
 at:string;
 /** shared: a note joined a shared lens. expanded / paused: a change nobody made grew a shared lens (D3). */
 kind:'shared'|'expanded'|'paused';
 lens:string;
 /** Server names, as the feed says them. */
 servers:string[];
 title?:string;
 reason?:LensReview['reason'];
}
export const lensEventsPath=(root:string,store:string)=>join(dirname(store),'lens-events',sha256hex(root)+'.jsonl');
function addEvents(root:string,store:string,events:LensEvent[]){
 if(!events.length)return;const path=lensEventsPath(root,store);mkdirSync(dirname(path),{recursive:true,mode:0o700});
 appendFileSync(path,events.map(e=>JSON.stringify(e)+'\n').join(''),{mode:0o600});
}
export function readLensEvents(root:string,store:string,limit=200):LensEvent[]{
 const path=lensEventsPath(root,store);if(!existsSync(path))return [];
 return readFileSync(path,'utf8').trim().split('\n').filter(Boolean).slice(-limit).map(l=>JSON.parse(l) as LensEvent);
}

// ── the move from server rules to lenses ────────────────────────────────────
/** Each server's rule, with its ratings, becomes a lens named after the server and shared with it.
 * What is on the server now stays: active contributions are added by hand, withdrawn ones removed.
 * A server that can't be reached keeps its rule until the next tick. */
export async function migrateRules(root:string,store:string,contributionsOf:(c:SharedConnection)=>Promise<Contribution[]>=contributions){
 for(const c of readConnections(store)){
  const rule=getRule(store,c.id);if(!rule||rule.root!==root)continue;
  let existing:Contribution[];try{existing=await contributionsOf(c);}catch{continue;}
  const scope=sharedRuleScope(c.id),policy=readInclusionPolicy(root,store,scope);
  const bySource=new Map(lensNotes(root).map(n=>[originOf(n.source_id),n.source_id]));
  const local=(status:string)=>existing.filter(x=>x.status===status).flatMap(x=>{const id=bySource.get(x.source_id);return id?[id]:[];});
  const pins=local('active');
  writeLens(root,store,newLens({name:c.name,text:rule.text,labels:policy?.labels??[],pins,exclusions:local('withdrawn'),servers:[c.id],members:pins,
   calibration:{identity:'',model:'',threshold:policy?.calibration?.threshold??.8},
   // The first pass fills this in, holding anything new for review, or drops it if nothing is.
   review:{reason:'update',hold:true,joins:[],leaves:[],at:''}}));
  recordShares(store,c.id,pins.map(originOf));
  dropRule(store,c.id);
  for(const draft of [false,true])rmSync(inclusionPath(root,store,scope,draft),{force:true});
 }
}

// ── one lens ────────────────────────────────────────────────────────────────
/** Score a lens over these notes and apply what changed. Returns the lens as written, or undefined if it changed meanwhile. */
export async function passLens(root:string,store:string,lens:Lens,notes:ReturnType<typeof lensNotes>,opts:PassOptions={}):Promise<Lens|undefined>{
 const pass=await scorePass(root,store,lens,notes,opts);
 if(readLens(root,store,lens.id)?.version!==lens.version)return; // edited meanwhile: the next tick starts over
 if(pass.outOfCredits){writeLens(root,store,{...lens,error:'Out of usage credits. (You need credits to keep this lens up to date.)'});return;}
 const next=membership(lens,notes,pass.scores),was=new Set(lens.members);
 const joins=[...next].filter(id=>!was.has(id)),leaves=lens.members.filter(id=>!next.has(id));
 const shared=lens.servers.length>0,first=!lens.calibration.identity,changed=!first&&pass.identity!==lens.calibration.identity;
 const now=new Date().toISOString();
 let review=lens.review;
 if(first&&review?.reason==='update')review=joins.length?{...review,joins,leaves,at:now}:undefined;
 else if(changed&&shared&&joins.length)review={reason:pass.model!==lens.calibration.model?'model':'vault',hold:review?.hold||sharingMode(store)==='conservative',joins,leaves,at:now};
 else if(review?.hold)review={...review,joins};
 // A held lens loses what stopped matching and gains nothing.
 const members=review?.hold?lens.members.filter(id=>next.has(id)):[...next];
 const added=review?.hold?[]:joins;
 const failures=[...new Set(pass.failed.values())];
 const written:Lens={...lens,members,review,
  summarized:members.filter(id=>pass.summarized.has(id)),
  calibration:{...lens.calibration,identity:pass.identity,model:pass.model},
  error:failures.length?`${pass.failed.size} ${pass.failed.size===1?'note':'notes'} could not be scored: ${failures[0]}`:undefined};
 writeLens(root,store,written);
 if(shared){
  const names=serverNames(store,lens.servers),titles=new Map(notes.map(n=>[n.source_id,n.title]));
  const opened=review&&review.at!==lens.review?.at?review:undefined;
  addEvents(root,store,opened
   // A change nobody made is one event, not one per note.
   ?[{at:opened.at,kind:opened.hold?'paused':'expanded',lens:lens.id,servers:names,reason:opened.reason}]
   :added.map(id=>({at:now,kind:'shared',lens:lens.id,servers:names,title:titles.get(id)??''})));
 }
 return written;
}
const serverNames=(store:string,ids:string[])=>{const all=readConnections(store);return ids.flatMap(id=>{const c=all.find(x=>x.id===id);return c?[c.name]:[];});};

// ── one server ──────────────────────────────────────────────────────────────
/** Bring a server in line with the lenses shared with it, within the write budget. */
export async function syncServer(store:string,c:SharedConnection,lenses:Lens[],notes:ReturnType<typeof lensNotes>,contributionsOf:(c:SharedConnection)=>Promise<Contribution[]>=contributions){
 const wanted=new Set(lenses.filter(l=>l.servers.includes(c.id)).flatMap(l=>l.members.map(originOf)));
 const owned=new Set(readShares(store)[c.id]??[]);
 const existing=await contributionsOf(c),byOrigin=new Map(existing.map(x=>[x.source_id,x]));
 const local=new Map(notes.map(n=>[originOf(n.source_id),n.insertion]));
 let budget=WRITE_BUDGET;
 // Withdraw first: shrinking what is shared is the safe direction.
 for(const x of existing){
  if(budget<=0)return;
  if(x.status!=='active'||wanted.has(x.source_id)||!owned.has(x.source_id)||!local.has(x.source_id))continue;
  await transition(c,x,'withdraw');recordShares(store,c.id,[],[x.source_id]);budget--;
 }
 for(const origin of wanted){
  const x=byOrigin.get(origin);if(x?.status!=='withdrawn')continue;
  if(budget<=0)return;
  await transition(c,x,'restore');recordShares(store,c.id,[origin]);budget--;
 }
 // sendSources posts up to 20 notes a request: the rest wait for the next tick.
 const missing=[...wanted].filter(o=>!byOrigin.has(o)&&local.has(o)).slice(0,Math.max(0,budget)*20).map(o=>local.get(o)!);
 if(missing.length){await sendSources(store,c,missing);recordShares(store,c.id,missing.map(s=>originOf(s.source_id)));}
}
async function transition(c:SharedConnection,x:Contribution,action:'withdraw'|'restore'){
 try{await sharedRequest(c,`/v1/contributions/${x.id}/${action}`,{request_id:randomUUID(),version:x.version});}
 catch(e){if(!(e instanceof SharedConnectionError&&e.status===409))throw e;} // changed meanwhile: the next tick sees it
}

// ── the tick ────────────────────────────────────────────────────────────────
const locks=new Set<string>();
export async function tickLenses(root:string,store:string){
 if(locks.has(store))return;locks.add(store);
 try{
  await migrateRules(root,store);
  const notes=lensNotes(root);
  for(const lens of listLenses(root,store))await passLens(root,store,lens,notes).catch(e=>console.error(`lens ${lens.id}: ${e instanceof Error?e.message:e}`));
  const lenses=listLenses(root,store);
  for(const c of readConnections(store)){
   if(getRule(store,c.id)?.root===root)continue; // not migrated yet: its lens doesn't exist to say what belongs
   await syncServer(store,c,lenses,notes).catch(()=>{/* unavailable or refused: the next tick retries */});
  }
 }finally{locks.delete(store);}
}
