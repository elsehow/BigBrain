/**
 * lensSync.ts — keeping lenses, and the servers they are shared with, in step.
 *
 * Every tick, each lens's inclusion stage scores the notes its verdicts do
 * not yet settle (lib/stages/inclusion.ts; cached scores make that cheap
 * once paid) and lands them as one inclusion assertion. A lens's members are
 * a view over its verdicts (lib/views/lens.ts): each note in, out, or
 * pending while no verdict under the lens's current rule decides it.
 *
 *   - A change nobody made to a shared lens (a model upgrade, the vault's
 *     entities, a BigBrain update) that would add notes to what is shared
 *     opens a review (decision D3). In Conservative mode, and always after
 *     an update, the lens takes no additions until someone says it looks
 *     OK. In Yee-haw mode the notes join and the review stays as a warning.
 *
 * Then each server is diffed against the view: notes in a lens shared with
 * it are contributed or restored, each a "shared" event for the feed
 * (typing the lens's name to share it consented to future matches, decision
 * D2); notes every such lens says are out are withdrawn; a pending note is
 * left where it is. Only what lenses contributed is ever withdrawn
 * (`lens-shares.json`); anything else a member put on a server stays.
 */
import {existsSync,mkdirSync,readdirSync,readFileSync,rmSync,appendFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeAtomic} from './fsx';
import {sha256hex} from './hash';
import {readConnections,sharedRequest,updateConnection,SharedConnectionError,type SharedConnection} from './sharedConnections';
import {contributions,dropRule,getRule,sendSources,sourceKey,type Contribution} from './sharedRules';
import {inclusionPath,readInclusionPolicy,sharedRuleScope} from './inclusionPolicy';
import {EVALUATOR_VERSION,inclusionEvaluator} from './inclusionEvaluation';
import type {InclusionVerdict} from './assertionLog';
import {legacyLensDir,listLenses,newLens,readLens,setLensError,sharingMode,updateLens,writeLens,type Lens,type LensReview} from './lenses';
import {labelsOf,landScores,readLensState,sayOnLens,type LensReading} from './lensRecord';
import {noteClaims,type NoteClaims} from './sharedRuleMentions';
import {inclusionStage,lensNotes,notesToScore,type PassOptions} from './stages/inclusion';
import {waiting} from './stages/stage';
import {withSnapshot} from './vaultReadModel';

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
/** What lenses put on these servers, as origins. */
export const sharedOrigins=(store:string,servers:readonly string[])=>{const all=readShares(store);return new Set(servers.flatMap(c=>all[c]??[]));};
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
 /** shared: the note's source id. */
 source?:string;
 reason?:LensReview['reason'];
}
export const lensEventsPath=(root:string,store:string)=>join(dirname(store),'lens-events',sha256hex(root)+'.jsonl');
function addEvents(root:string,store:string,events:LensEvent[]){
 if(!events.length)return;const path=lensEventsPath(root,store);mkdirSync(dirname(path),{recursive:true,mode:0o700});
 appendFileSync(path,events.map(e=>JSON.stringify(e)+'\n').join(''),{mode:0o600});
}
const CAUSE={model:'A model upgrade',vault:'A vault change',update:'A BigBrain update'} as const;
/** A sharing event as the feed says it (decisions D2 and D3). */
export function lensEventHeadline(e:LensEvent,count=1):string{
 const servers=e.servers.join(', ');
 if(e.kind==='shared'&&count>1)return `${count} items are shared with ${servers}`;
 if(e.kind==='shared'){const t=e.title??'';return `${t.length>48?t.slice(0,48).trimEnd()+'…':t} is shared with ${servers}`;}
 const cause=CAUSE[e.reason??'model'];
 return e.kind==='paused'?`${cause} would cause you to share new items with ${servers}. Lens is paused until you review.`:`${cause} has caused you to share new items with ${servers}.`;
}
/** The feed's lens rows: what a lens shared stays, a review only until it is
 * cleared (Looks OK, or a new rule saved), and what one pass shared from a
 * lens is one row, so a review released all at once doesn't bury the feed.
 * `sources`: the notes a shared row brought. */
export function feedLensEvents(root:string,store:string):{event:LensEvent;count:number;sources:string[]}[]{
 const lenses=listLenses(root),open=new Set(lenses.flatMap(l=>l.review?.at?[`${l.id} ${l.review.at}`]:[]));
 // A shared event written before events named their note: the lens's members of that title.
 const named=(e:LensEvent)=>{const lens=lenses.find(l=>l.id===e.lens);if(!lens)return [];const {members,notes}=readLensState(root,lens);
  return notes.filter(n=>members.in.has(n.source_id)&&n.title===e.title).map(n=>n.source_id);};
 const rows=new Map<string,{event:LensEvent;count:number;sources:string[]}>();
 for(const e of readLensEvents(root,store,Infinity)){
  if(e.kind!=='shared'&&!open.has(`${e.lens} ${e.at}`))continue;
  const key=`${e.kind} ${e.lens} ${e.at}`,row=rows.get(key)??{event:e,count:0,sources:[]};
  row.count++;rows.set(key,row);
  if(e.kind==='shared')row.sources.push(...(e.source?[e.source]:named(e)));
 }
 return [...rows.values()];
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
  const lens=newLens({name:c.name,text:rule.text,servers:[c.id],
   calibration:{identity:'',model:'',threshold:policy?.calibration?.threshold??.8},
   // The first pass fills this in, holding anything new for review, or drops it if nothing is.
   review:{reason:'update',hold:true,at:''}});
  writeLens(root,lens,`lens: ${lens.name} — from ${c.name}'s rule`);
  sayOnLens(root,lens,{pins,exclusions:local('withdrawn'),ratings:(policy?.labels??[]).map(l=>({insertion_id:l.source.id,include:l.include}))});
  recordShares(store,c.id,pins.map(originOf));
  updateConnection(store,c.id,{root});
  dropRule(store,c.id);
  for(const draft of [false,true])rmSync(inclusionPath(root,store,scope,draft),{force:true});
 }
}

// ── one lens ────────────────────────────────────────────────────────────────
export interface LensPassOptions extends PassOptions {
 /** Each note revision's claims, read once a tick. */
 claims?:ReadonlyMap<string,NoteClaims>;
}
/** Run a lens's inclusion stage over these notes, land what it scored, and
 * open or settle a D3 review. Returns the lens as written, or undefined if
 * it changed meanwhile. */
export async function passLens(root:string,store:string,lens:Lens,notes:ReturnType<typeof lensNotes>,opts:LensPassOptions={}):Promise<Lens|undefined>{
 const before=readLensState(root,lens),labels=labelsOf(root,before.hands.ratings);
 const evaluator=(opts.factory??inclusionEvaluator)(root,store,lens.text,labels);
 const stage=inclusionStage(lens,{identity:evaluator.identity,labels},notesToScore(notes,opts.claims??noteClaims(root)),{root,store,pass:opts});
 const todo=withSnapshot(root,s=>waiting(stage,s)),verdicts:InclusionVerdict[]=[];
 if(todo.length)await stage.run({write:{append:v=>verdicts.push(v)}},todo);
 if(readLens(root,lens.id)?.version!==lens.version)return; // edited meanwhile: the next tick starts over
 landScores(root,lens,evaluator.identity,evaluator.model,verdicts);
 const failures=[...new Set(stage.failed.values())];
 setLensError(root,lens.id,stage.outOfCredits?'Out of usage credits. (You need credits to keep this lens up to date.)'
  :failures.length?`${stage.failed.size} ${stage.failed.size===1?'note':'notes'} could not be scored: ${failures[0]}`:undefined);
 return reviewLens(root,store,lens,readLensState(root,lens),evaluator);
}

/** A shared lens whose members a change nobody made would grow opens a
 * review (D3); one that grows nothing keeps the calibration it was saved
 * with current. A private lens just follows its rule. */
function reviewLens(root:string,store:string,lens:Lens,state:LensReading,rule:{identity:string;model:string}):Lens{
 const shared=lens.servers.length>0,adopt=(l:Lens)=>{l.calibration={...l.calibration,identity:rule.identity,model:rule.model,version:EVALUATOR_VERSION};};
 if(state.members.rule!==rule.identity)return lens; // nothing scored under this rule yet
 // A lens never scored before takes its first rule as the one its owner saw.
 if(!lens.calibration.identity&&!lens.review)return updateLens(root,lens.id,adopt);
 if(!shared)return lens;
 const owned=new Set(lens.servers.flatMap(c=>readShares(store)[c]??[]));
 const joins=[...state.members.in].filter(id=>!owned.has(originOf(id)));
 const changed=lens.calibration.identity!==rule.identity;
 if(lens.review&&!lens.review.at){ // migrated: the first pass says whether anything new would join
  if(!joins.length)return updateLens(root,lens.id,l=>{l.review=undefined;adopt(l);});
  const opened=updateLens(root,lens.id,l=>{l.review={...l.review!,at:new Date().toISOString()};});
  addEvents(root,store,[{at:opened.review!.at,kind:'paused',lens:lens.id,servers:serverNames(store,lens.servers),reason:'update'}]);
  return opened;
 }
 if(!changed||lens.review)return lens;
 if(!joins.length)return updateLens(root,lens.id,adopt);
 const reason:LensReview['reason']=rule.model!==lens.calibration.model?'model':lens.calibration.version!==EVALUATOR_VERSION?'update':'vault';
 const review:LensReview={reason,hold:reason==='update'||sharingMode(store)==='conservative',at:new Date().toISOString()};
 const opened=updateLens(root,lens.id,l=>{l.review=review;},`lens: ${lens.name} — a change nobody made would share more`);
 addEvents(root,store,[{at:review.at,kind:review.hold?'paused':'expanded',lens:lens.id,servers:serverNames(store,lens.servers),reason}]);
 return opened;
}
const serverNames=(store:string,ids:string[])=>{const all=readConnections(store);return ids.flatMap(id=>{const c=all.find(x=>x.id===id);return c?[c.name]:[];});};

// ── one server ──────────────────────────────────────────────────────────────
/** A lens as a server sees it: its file, and its members as the view says. */
export interface SharedLens {lens:Lens;state:LensReading}
/** Bring a server in line with the lenses shared with it, within the write
 * budget: what any of them holds is wanted, unless a review holds that lens's
 * additions; what every one that decides it says is out is withdrawn; a
 * pending note stays where it is. */
export async function syncServer(root:string,store:string,c:SharedConnection,lenses:SharedLens[],notes:ReturnType<typeof lensNotes>,contributionsOf:(c:SharedConnection)=>Promise<Contribution[]>=contributions){
 const mine=lenses.filter(l=>l.lens.servers.includes(c.id));
 const owned=new Set(readShares(store)[c.id]??[]);
 const holds=(l:SharedLens)=>!!l.lens.review?.hold;
 const wanted=new Set(mine.flatMap(l=>[...l.state.members.in].map(originOf).filter(o=>!holds(l)||owned.has(o))));
 const undecided=new Set(mine.flatMap(l=>[...l.state.members.pending].map(originOf)));
 const existing=await contributionsOf(c),byOrigin=new Map(existing.map(x=>[x.source_id,x]));
 const local=new Map(notes.map(n=>[originOf(n.source_id),n.insertion]));
 const titles=new Map(notes.map(n=>[originOf(n.source_id),{title:n.title,source:n.source_id}]));
 const shared:LensEvent[]=[],now=new Date().toISOString(),names=serverNames(store,[c.id]);
 const lensOf=(origin:string)=>mine.find(l=>l.state.members.in.has(titles.get(origin)?.source??''))?.lens.id??'';
 const announce=(origin:string)=>{const t=titles.get(origin);if(t)shared.push({at:now,kind:'shared',lens:lensOf(origin),servers:names,title:t.title,source:t.source});};
 let budget=WRITE_BUDGET;
 try{
  // Withdraw first: shrinking what is shared is the safe direction.
  for(const x of existing){
   if(budget<=0)return;
   if(x.status!=='active'||wanted.has(x.source_id)||undecided.has(x.source_id)||!owned.has(x.source_id)||!local.has(x.source_id))continue;
   await transition(c,x,'withdraw');recordShares(store,c.id,[],[x.source_id]);budget--;
  }
  for(const origin of wanted){
   const x=byOrigin.get(origin);if(x?.status!=='withdrawn')continue;
   if(budget<=0)return;
   await transition(c,x,'restore');recordShares(store,c.id,[origin]);announce(origin);budget--;
  }
  // sendSources posts up to 20 notes a request: the rest wait for the next tick.
  const missing=[...wanted].filter(o=>!byOrigin.has(o)&&local.has(o)).slice(0,Math.max(0,budget)*20);
  if(missing.length){await sendSources(store,c,missing.map(o=>local.get(o)!));recordShares(store,c.id,missing);for(const o of missing)announce(o);}
 }finally{addEvents(root,store,shared);}
}
async function transition(c:SharedConnection,x:Contribution,action:'withdraw'|'restore'){
 try{await sharedRequest(c,`/v1/contributions/${x.id}/${action}`,{request_id:randomUUID(),version:x.version});}
 catch(e){if(!(e instanceof SharedConnectionError&&e.status===409))throw e;} // changed meanwhile: the next tick sees it
}

// ── the tick ────────────────────────────────────────────────────────────────
const locks=new Set<string>();
/** The vault a server is shared from: the one whose rule it migrated from, or
 * whose lens first shared with it. Only that vault's lenses decide what is on
 * it, so opening another vault (a scratch one, a second one) never reads as
 * "nothing is shared any more" and withdraws everything. */
export function vaultOf(store:string,c:SharedConnection,root:string,lenses:Lens[]):string|undefined{
 if(!c.root&&lenses.some(l=>l.servers.includes(c.id))){updateConnection(store,c.id,{root});return root;}
 return c.root;
}

/** Lenses kept beside this computer's settings, from before they moved into the vault. */
export function unmigratedLenses(root:string,store:string):number{
 const dir=legacyLensDir(root,store);return existsSync(dir)?readdirSync(dir).filter(f=>/^lens_[a-f0-9]{12}\.json$/.test(f)).length:0;
}

export async function tickLenses(root:string,store:string){
 // Until `bigbrain migrate` moves them in, the vault's lenses say nothing, and a
 // server synced against nothing would have every lens's notes withdrawn.
 if(unmigratedLenses(root,store))return;
 if(locks.has(store))return;locks.add(store);
 try{
  await migrateRules(root,store);
  const notes=lensNotes(root),claims=noteClaims(root);
  // A few new summaries a tick: the first pass over a vault's largest notes spreads out instead of stalling.
  for(const lens of listLenses(root))await passLens(root,store,lens,notes,{summaries:3,claims}).catch(e=>console.error(`lens ${lens.id}: ${e instanceof Error?e.message:e}`));
  const lenses=listLenses(root).map(lens=>({lens,state:readLensState(root,lens)}));
  for(const c of readConnections(store)){
   if(getRule(store,c.id)?.root===root)continue; // not migrated yet: its lens doesn't exist to say what belongs
   if(vaultOf(store,c,root,lenses.map(l=>l.lens))!==root)continue; // another vault's, or no vault's yet: these lenses don't speak for it
   await syncServer(root,store,c,lenses,notes).catch(()=>{/* unavailable or refused: the next tick retries */});
  }
 }finally{locks.delete(store);}
}
