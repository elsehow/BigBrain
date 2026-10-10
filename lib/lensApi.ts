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
import {rmSync} from 'node:fs';
import {resolveRuleMentions} from './sharedRuleMentions';
import {fitThreshold,lensScope,listLenses,membership,newLens,readLens,removeLens,setSharingMode,sharingMode,updateLens,writeLens,type Lens} from './lenses';
import {lensNotes,scorePass,type LensPass} from './lensScoring';
import {readLensEvents,tickLenses} from './lensSync';

const LENS_ID=/^lens_[a-f0-9]{12}$/;
const checkId=(id:unknown):string=>{if(typeof id!=='string'||!LENS_ID.test(id))throw Error('Unknown lens.');return id;};

interface Preview {id:string;root:string;lens:string;text:string;labels:InclusionLabel[];busy:boolean;done:number;total:number;error?:string;pass?:LensPass;threshold?:number;at:number}
const previews=new Map<string,Preview>();

/** Each note the rule takes, or the lens had: what the table needs, with hand edits left to the screen. */
function previewRows(p:Preview,lens:Lens|undefined){
 if(!p.pass)return [];
 const notes=lensNotes(p.root),was=new Set(lens?.members??[]),pins=new Set(lens?.pins??[]),exclusions=new Set(lens?.exclusions??[]);
 // The rule's own answer, before hand edits: ratings, then score, then the note's old place.
 const ruled=membership({labels:p.labels,pins:[],exclusions:[],members:lens?.members??[],calibration:{identity:'',model:'',threshold:p.threshold!}},notes,p.pass.scores);
 return notes.filter(n=>ruled.has(n.source_id)||was.has(n.source_id)||pins.has(n.source_id)||exclusions.has(n.source_id)).map(n=>({
  id:n.source_id,title:n.title,date:(n.insertion.received_at??n.insertion.occurred_at??'').slice(0,10),
  rule:ruled.has(n.source_id),was:was.has(n.source_id),summarized:p.pass!.summarized.has(n.source_id),failed:p.pass!.failed.has(n.source_id),
 }));
}
function previewView(p:Preview){
 const lens=readLens(p.root,connectionStorePath(),p.lens);
 return {id:p.id,busy:p.busy,done:p.done,total:p.total,error:p.error,failed:p.pass?.failed.size??0,rows:p.busy?[]:previewRows(p,lens)};
}

function startPreview(root:string,store:string,id:string,text:unknown):ReturnType<typeof previewView>{
 if(typeof text!=='string'||!text.trim()||text.length>8000)throw Error('Write a rule first.');
 resolveRuleMentions(root,text);
 for(const [key,p] of previews)if(p.lens===id||Date.now()-p.at>3600000)previews.delete(key);
 const labels=readInclusionPolicy(root,store,lensScope(id))?.labels??readLens(root,store,id)?.labels??[];
 const notes=lensNotes(root);
 const p:Preview={id:randomUUID(),root,lens:id,text:text.trim(),labels,busy:true,done:0,total:notes.length,at:Date.now()};previews.set(p.id,p);
 void (async()=>{try{
  const pass=await scorePass(root,store,{text:p.text,labels},notes,{current:()=>previews.has(p.id),progress:done=>{p.done=done;}});
  if(pass.outOfCredits)throw Error('Out of usage credits. (You need credits to see what this rule includes.)');
  const digests=new Map(notes.map(n=>[n.digest,n.source_id]));
  p.threshold=fitThreshold(labels.flatMap(l=>{const sid=digests.get(sourceDigest(l.source));const score=sid?pass.scores.get(sid):undefined;return score===undefined?[]:[{include:l.include,score}];}));
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
 const before=readLens(root,store,id),notes=lensNotes(root);
 const fields={name:body.name.trim(),text:p.text,labels:p.labels,pins,exclusions,calibration:{identity:p.pass.identity,model:p.pass.model,threshold:p.threshold!}};
 const members=[...membership({...fields,members:before?.members??[]},notes,p.pass.scores)];
 const joins=members.filter(m=>!before?.members.includes(m));
 if(before?.servers.length&&joins.length&&!confirmed(before,body.confirm))throw Error('Type the lens’s name to share these notes.');
 const lens:Lens=before?{...before,...fields,members,summarized:members.filter(m=>p.pass!.summarized.has(m)),review:undefined,error:undefined,version:randomUUID(),updated:new Date().toISOString()}
  :newLens({id,...fields,members,summarized:members.filter(m=>p.pass!.summarized.has(m))});
 writeLens(root,store,lens);previews.delete(p.id);
 // The lens now holds the review's ratings; a later edit starts from them.
 for(const draft of [false,true])rmSync(inclusionPath(root,store,lensScope(id),draft),{force:true});
 void tickLenses(root,store);
 return lens;
}

async function share(root:string,store:string,body:{id?:unknown;server?:unknown;on?:unknown;confirm?:unknown}){
 const id=checkId(body.id),lens=readLens(root,store,id);if(!lens)throw Error('Save the lens first.');
 const c=readConnections(store).find(x=>x.id===body.server);if(!c)throw Error('Server unavailable.');
 if(!confirmed(lens,body.confirm))throw Error('Type the lens’s name to confirm.');
 if(body.on===true){const who=await sharedRequest<{permissions:string[]}>(c,'/v1/whoami');if(!who.permissions.includes('write'))throw Error('This server is read-only.');}
 const updated=updateLens(root,store,id,l=>{l.servers=body.on===true?[...new Set([...l.servers,c.id])]:l.servers.filter(s=>s!==c.id);});
 void tickLenses(root,store);
 return updated;
}

function summary(store:string,lens:Lens){
 const servers=readConnections(store);
 return {id:lens.id,name:lens.name,text:lens.text,members:lens.members.length,error:lens.error,
  servers:lens.servers.flatMap(s=>{const c=servers.find(x=>x.id===s);return c?[{id:c.id,name:c.name}]:[];}),
  review:lens.review&&lens.review.at?{reason:lens.review.reason,hold:lens.review.hold,joins:lens.review.joins.length,leaves:lens.review.leaves.length,at:lens.review.at}:undefined};
}
function detail(root:string,store:string,lens:Lens){
 const byId=new Map(lensNotes(root).map(n=>[n.source_id,n]));
 const row=(sid:string)=>{const n=byId.get(sid);return n?[{id:sid,title:n.title,date:(n.insertion.received_at??n.insertion.occurred_at??'').slice(0,10)}]:[];};
 return {...summary(store,lens),pins:lens.pins,exclusions:lens.exclusions,summarized:lens.summarized,
  notes:lens.members.flatMap(row),review:lens.review&&lens.review.at?{...lens.review,joins:lens.review.joins.flatMap(row),leaves:lens.review.leaves.flatMap(row)}:undefined};
}

export async function lensApi(req:IncomingMessage,res:ServerResponse,root:string){
 const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith('/api/lenses'))return false;
 if(!allowVaultRequest(req,res,vaultIdentity(root)))return true;
 const store=connectionStorePath(),action=url.pathname.slice('/api/lenses'.length).replace(/^\//,'');
 try{
  if(req.method==='GET'){
   if(action===''){json(res,200,{lenses:listLenses(root,store).map(l=>summary(store,l)),servers:readConnections(store).map(c=>({id:c.id,name:c.name})),mode:sharingMode(store)});return true;}
   if(action==='lens'){const lens=readLens(root,store,checkId(url.searchParams.get('id')));if(!lens)throw Error('This lens no longer exists.');json(res,200,detail(root,store,lens));return true;}
   if(action==='notes'){
    const words=(url.searchParams.get('q')??'').toLowerCase().trim().split(/\s+/).filter(Boolean),out:{id:string;title:string;date:string}[]=[];
    for(const n of lensNotes(root).reverse()){if(out.length>=20)break;const text=(n.title+'\n'+n.body).toLowerCase();if(words.every(w=>text.includes(w)))out.push({id:n.source_id,title:n.title,date:(n.insertion.received_at??n.insertion.occurred_at??'').slice(0,10)});}
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
  else if(action==='review-ok'){const lens=updateLens(root,store,checkId(body.id),l=>{l.review=undefined;});void tickLenses(root,store);json(res,200,detail(root,store,lens));}
  else if(action==='delete'){
   const id=checkId(body.id),lens=readLens(root,store,id);
   if(lens?.servers.length&&!confirmed(lens,body.confirm))throw Error('Type the lens’s name to confirm.');
   removeLens(root,store,id);void tickLenses(root,store);json(res,200,{ok:true});
  }
  else if(action==='mode')json(res,200,{mode:setSharingMode(store,body.mode)});
  else json(res,404,{error:'Not found'});
 }catch(e){json(res,400,{error:e instanceof Error?e.message:'Could not update the lens.'});}
 return true;
}
