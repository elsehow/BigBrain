/**
 * /api/lenses — Settings › lenses and Edit a lens (docs/plans/lenses-and-servers.md).
 *
 *   GET  /api/lenses                     every lens, the servers it can be shared with, the Sharing mode
 *   POST /api/lenses/new                 an id for a lens not saved yet (its rule review is keyed on it)
 *   GET  /api/lenses/lens?id=            one lens: its rule, servers, review, and the notes in it
 *   GET  /api/lenses/notes?q=            notes to add by hand: every word in the title or text
 *   POST /api/lenses/preview             {id, text} → score the whole vault against the rule and its ratings
 *   GET  /api/lenses/preview?id=         that pass: progress, then each note the rule takes or the lens had
 *   POST /api/lenses/save                {id, name, text, pins, exclusions, preview, confirm?}
 *   POST /api/lenses/share               {id, server, on, confirm}
 *   POST /api/lenses/review-ok           {id} — "Looks OK" on a D3 review
 *   POST /api/lenses/delete              {id, confirm?}
 *   POST /api/lenses/mode                {mode} — Conservative or Yee-haw (D3)
 *   GET  /api/lenses/events              the feed's sharing events
 *
 * Anything that widens what a server sees is refused unless `confirm` is the
 * lens's name, typed: the screens ask first, and the engine checks.
 */
import type {IncomingMessage,ServerResponse} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {json,readBody} from './httpx';
import {allowVaultRequest,vaultIdentity} from './vaultBoundary';
import {connectionStorePath,readConnections,sharedRequest} from './sharedConnections';
import {inclusionPath,readInclusionPolicy,sourceDigest,type InclusionLabel} from './inclusionPolicy';
import {EVALUATOR_VERSION,inclusionEvaluator} from './inclusionEvaluation';
import {rmSync} from 'node:fs';
import {LENS_ID} from './ids';
import {resolveRuleMentions,noteClaims} from './sharedRuleMentions';
import {fitThreshold,lensError,lensScope,previewThreshold,listLenses,newLens,readLens,removeLens,ruled,setSharingMode,sharingMode,updateLens,writeLens,type Lens} from './lenses';
import {labelsOf,landScores,readLensState,sayOnLens,type LensReading} from './lensRecord';
import {lensNotes,scorePass,verdictInput,type LensPass} from './stages/inclusion';
import {insertionEventRel} from './insertionLog';
import {originOf,readLensEvents,sharedOrigins,tickLenses,unmigratedLenses} from './lensSync';

const checkId=(id:unknown):string=>{if(typeof id!=='string'||!LENS_ID.test(id))throw Error('Unknown lens.');return id;};

interface Preview {id:string;root:string;lens:string;text:string;labels:InclusionLabel[];busy:boolean;done:number;total:number;error?:string;pass?:LensPass;threshold?:number;at:number}
const previews=new Map<string,Preview>();

/** The rule's own answer from a preview: its ratings, by source, then its scores. */
function previewRuled(p:Preview,notes:ReturnType<typeof lensNotes>){
 const bySource=new Map(notes.map(n=>[n.insertion.id,n.source_id]));
 const ratings=new Map(p.labels.flatMap(l=>{const id=bySource.get(l.source.id)??notes.find(n=>n.digest===sourceDigest(l.source))?.source_id;return id?[[id,l.include] as const]:[];}));
 return ruled(ratings,p.threshold!,notes,p.pass!.scores);
}

/** Each note the rule takes, or the lens had: what the table needs, with hand edits left to the screen. */
function previewRows(p:Preview,state:LensReading|undefined){
 if(!p.pass)return [];
 const notes=lensNotes(p.root),was=state?.members.in??new Set<string>(),pins=new Set(state?.hands.pins??[]),exclusions=new Set(state?.hands.exclusions??[]);
 const rule=previewRuled(p,notes).in;
 return notes.filter(n=>rule.has(n.source_id)||was.has(n.source_id)||pins.has(n.source_id)||exclusions.has(n.source_id)).map(n=>({
  id:n.source_id,title:n.title,date:(n.insertion.received_at??n.insertion.occurred_at??'').slice(0,10),path:insertionEventRel(n.insertion),
  rule:rule.has(n.source_id),was:was.has(n.source_id),summarized:p.pass!.summarized.has(n.source_id),failed:p.pass!.failed.has(n.source_id),
 }));
}
function previewView(p:Preview){
 const lens=readLens(p.root,p.lens);
 return {id:p.id,busy:p.busy,done:p.done,total:p.total,error:p.error,failed:p.pass?.failed.size??0,rows:p.busy?[]:previewRows(p,lens&&readLensState(p.root,lens))};
}

/** A lens's ratings as the evaluator is taught them: a rule review's, while one is open, else the record's. */
const ratingsFor=(root:string,store:string,id:string,lens:Lens|undefined):InclusionLabel[]=>
 readInclusionPolicy(root,store,lensScope(id))?.labels??(lens?labelsOf(root,readLensState(root,lens).hands.ratings):[]);

function startPreview(root:string,store:string,id:string,text:unknown):ReturnType<typeof previewView>{
 if(typeof text!=='string'||!text.trim()||text.length>8000)throw Error('Write a rule first.');
 resolveRuleMentions(root,text);
 for(const [key,p] of previews)if(p.lens===id||Date.now()-p.at>3600000)previews.delete(key);
 const lens=readLens(root,id),labels=ratingsFor(root,store,id,lens);
 const saved=lens&&{...lens,labels:labelsOf(root,readLensState(root,lens).hands.ratings)};
 const notes=lensNotes(root);
 const p:Preview={id:randomUUID(),root,lens:id,text:text.trim(),labels,busy:true,done:0,total:notes.length,at:Date.now()};previews.set(p.id,p);
 void (async()=>{try{
  const pass=await scorePass(root,store,{text:p.text,labels},notes,{fresh:true,summaries:0,current:()=>previews.has(p.id),progress:done=>{p.done=done;}});
  if(pass.outOfCredits)throw Error('Out of usage credits. (You need credits to see what this rule includes.)');
  const digests=new Map(notes.map(n=>[n.digest,n.source_id]));
  p.threshold=previewThreshold(saved,p.text,labels,()=>fitThreshold(labels.flatMap(l=>{const sid=digests.get(sourceDigest(l.source));const score=sid?pass.scores.get(sid):undefined;return score===undefined?[]:[{include:l.include,score}];})));
  p.pass=pass;
 }catch(e){p.error=e instanceof Error?e.message:String(e);}finally{p.busy=false;}})();
 return previewView(p);
}

function ids(v:unknown):string[]{if(!Array.isArray(v)||!v.every(x=>typeof x==='string'))throw Error('Invalid notes.');return [...new Set(v)];}
const confirmed=(lens:Pick<Lens,'name'>,confirm:unknown)=>typeof confirm==='string'&&confirm.trim()===lens.name.trim();

function save(root:string,store:string,body:{id?:unknown;name?:unknown;text?:unknown;pins?:unknown;exclusions?:unknown;preview?:unknown;confirm?:unknown}){
 const id=checkId(body.id),p=previews.get(String(body.preview??''));
 if(typeof body.name!=='string'||!body.name.trim()||body.name.length>80)throw Error('Name the lens.');
 if(!p||p.lens!==id||p.busy||!p.pass||p.error)throw Error('Wait for the preview to finish.');
 if(typeof body.text!=='string'||body.text.trim()!==p.text)throw Error('The rule changed. Wait for the new preview.');
 const pins=ids(body.pins),exclusions=ids(body.exclusions).filter(x=>!pins.includes(x));
 const before=readLens(root,id),notes=lensNotes(root),had=before?readLensState(root,before).members.in:new Set<string>();
 const rule=previewRuled(p,notes),pinned=new Set(pins),excluded=new Set(exclusions);
 const joins=notes.filter(n=>!excluded.has(n.source_id)&&(pinned.has(n.source_id)||rule.in.has(n.source_id))&&!had.has(n.source_id));
 if(before?.servers.length&&joins.length&&!confirmed(before,body.confirm))throw Error('Type the lens’s name to share these notes.');
 const calibration={identity:p.pass.identity,model:p.pass.model,threshold:p.threshold!,version:EVALUATOR_VERSION};
 const lens:Lens=before?{...before,name:body.name.trim(),text:p.text,calibration,review:undefined,version:randomUUID(),updated:new Date().toISOString()}
  :newLens({id,name:body.name.trim(),text:p.text,calibration});
 writeLens(root,lens,`lens: ${lens.name} — saved`);
 // The owner's word, then what the preview scored: the record now says what the screen showed.
 sayOnLens(root,lens,{pins,exclusions,ratings:p.labels.map(l=>({insertion_id:l.source.id,include:l.include}))});
 const claims=noteClaims(root);
 landScores(root,lens,p.pass.identity,p.pass.model,notes.flatMap(n=>{const score=p.pass!.scores.get(n.source_id);return score===undefined?[]:[{
  insertion_id:n.insertion.id,source_id:n.source_id,input:verdictInput(n.digest,claims.get(n.insertion.id)),score,...(p.pass!.summarized.has(n.source_id)?{summary:true as const}:{})}];}));
 previews.delete(p.id);
 // The record now holds the review's ratings; a later edit starts from them.
 for(const draft of [false,true])rmSync(inclusionPath(root,store,lensScope(id),draft),{force:true});
 void tickLenses(root,store);
 return readLens(root,id)!;
}

async function share(root:string,store:string,body:{id?:unknown;server?:unknown;on?:unknown;confirm?:unknown}){
 const id=checkId(body.id),lens=readLens(root,id);if(!lens)throw Error('Save the lens first.');
 const c=readConnections(store).find(x=>x.id===body.server);if(!c)throw Error('Server unavailable.');
 if(!confirmed(lens,body.confirm))throw Error('Type the lens’s name to confirm.');
 if(body.on===true){
  if(c.root&&c.root!==root)throw Error('This server is shared from another vault.');
  const who=await sharedRequest<{permissions:string[]}>(c,'/v1/whoami');if(!who.permissions.includes('write'))throw Error('This server is read-only.');
 }
 const updated=updateLens(root,id,l=>{l.servers=body.on===true?[...new Set([...l.servers,c.id])]:l.servers.filter(s=>s!==c.id);},
  `lens: ${lens.name} — ${body.on===true?'shared with':'no longer shared with'} ${c.name}`);
 void tickLenses(root,store);
 return updated;
}

/** What a review would add to the servers the lens is shared with, and take off them. */
function reviewChanges(store:string,lens:Lens,state:LensReading){
 const owned=sharedOrigins(store,lens.servers);
 return {joins:[...state.members.in].filter(id=>!owned.has(originOf(id))),leaves:state.notes.filter(n=>owned.has(originOf(n.source_id))&&state.members.out.has(n.source_id)).map(n=>n.source_id)};
}
function summary(root:string,store:string,lens:Lens,state=readLensState(root,lens)){
 const servers=readConnections(store),changes=lens.review?.at?reviewChanges(store,lens,state):undefined;
 return {id:lens.id,name:lens.name,text:lens.text,members:state.members.in.size,pending:state.members.pending.size,error:lensError(root,lens.id),
  servers:lens.servers.flatMap(s=>{const c=servers.find(x=>x.id===s);return c?[{id:c.id,name:c.name}]:[];}),
  review:lens.review&&changes?{reason:lens.review.reason,hold:lens.review.hold,joins:changes.joins.length,leaves:changes.leaves.length,at:lens.review.at}:undefined};
}
function detail(root:string,store:string,lens:Lens){
 const state=readLensState(root,lens),byId=new Map(lensNotes(root).map(n=>[n.source_id,n]));
 const row=(sid:string)=>{const n=byId.get(sid);return n?[{id:sid,title:n.title,date:(n.insertion.received_at??n.insertion.occurred_at??'').slice(0,10),path:insertionEventRel(n.insertion)}]:[];};
 const changes=lens.review?.at?reviewChanges(store,lens,state):undefined;
 return {...summary(root,store,lens,state),pins:state.hands.pins,exclusions:state.hands.exclusions,summarized:[...state.members.summarized],
  notes:[...state.members.in].flatMap(row),
  review:lens.review&&changes?{reason:lens.review.reason,hold:lens.review.hold,at:lens.review.at,joins:changes.joins.flatMap(row),leaves:changes.leaves.flatMap(row)}:undefined};
}

/** "Looks OK" on a review: what the lens is scored with now is what the owner has seen. */
function reviewOk(root:string,store:string,id:string):Lens{
 const lens=readLens(root,id);if(!lens)throw Error('This lens no longer exists.');
 const evaluator=inclusionEvaluator(root,store,lens.text,labelsOf(root,readLensState(root,lens).hands.ratings));
 return updateLens(root,id,l=>{l.review=undefined;l.calibration={...l.calibration,identity:evaluator.identity,model:evaluator.model,version:EVALUATOR_VERSION};},`lens: ${lens.name} — reviewed`);
}


/** `entitiesOf`: the entities claims citing these notes name (web/server.ts reads the record). */
export async function lensApi(req:IncomingMessage,res:ServerResponse,root:string,entitiesOf:(sourceIds:ReadonlySet<string>)=>string[]){
 const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith('/api/lenses'))return false;
 if(!allowVaultRequest(req,res,vaultIdentity(root)))return true;
 const store=connectionStorePath(),action=url.pathname.slice('/api/lenses'.length).replace(/^\//,'');
 try{
  if(req.method==='GET'){
   if(action===''){json(res,200,{lenses:listLenses(root).map(l=>summary(root,store,l)),servers:readConnections(store).map(c=>({id:c.id,name:c.name})),mode:sharingMode(store),unmigrated:unmigratedLenses(root,store)});return true;}
   if(action==='lens'||action==='entities'){
    const lens=readLens(root,checkId(url.searchParams.get('id')));if(!lens)throw Error('This lens no longer exists.');
    json(res,200,action==='lens'?detail(root,store,lens):{entities:entitiesOf(readLensState(root,lens).members.in)});return true;
   }
   if(action==='notes'){
    const words=(url.searchParams.get('q')??'').toLowerCase().trim().split(/\s+/).filter(Boolean),out:{id:string;title:string;date:string;path:string}[]=[];
    for(const n of lensNotes(root).reverse()){if(out.length>=20)break;const text=(n.title+'\n'+n.body).toLowerCase();if(words.every(w=>text.includes(w)))out.push({id:n.source_id,title:n.title,date:(n.insertion.received_at??n.insertion.occurred_at??'').slice(0,10),path:insertionEventRel(n.insertion)});}
    json(res,200,{items:out});return true;
   }
   if(action==='preview'){const p=previews.get(url.searchParams.get('id')??'');if(!p||p.root!==root)throw Error('This preview expired. Edit the rule again.');json(res,200,previewView(p));return true;}
   if(action==='events'){json(res,200,{events:readLensEvents(root,store)});return true;}
   json(res,404,{error:'Not found'});return true;
  }
  if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
  const body=JSON.parse(await readBody(req,200000)) as Record<string,unknown>;
  if(action==='new')json(res,200,{id:'lens_'+randomBytes(6).toString('hex')});
  else if(action==='preview')json(res,202,startPreview(root,store,checkId(body.id),body.text));
  else if(action==='save')json(res,200,detail(root,store,save(root,store,body)));
  else if(action==='share')json(res,200,detail(root,store,await share(root,store,body)));
  else if(action==='review-ok'){const lens=reviewOk(root,store,checkId(body.id));void tickLenses(root,store);json(res,200,detail(root,store,lens));}
  else if(action==='delete'){
   const id=checkId(body.id),lens=readLens(root,id);
   if(lens?.servers.length&&!confirmed(lens,body.confirm))throw Error('Type the lens’s name to confirm.');
   removeLens(root,id);void tickLenses(root,store);json(res,200,{ok:true});
  }
  else if(action==='mode')json(res,200,{mode:setSharingMode(store,body.mode)});
  else json(res,404,{error:'Not found'});
 }catch(e){json(res,400,{error:e instanceof Error?e.message:'Could not update the lens.'});}
 return true;
}
