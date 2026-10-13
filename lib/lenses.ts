/**
 * lenses.ts — a lens is a named rule over this vault (docs/plans/lenses-and-servers.md).
 * It lives in the vault (decided 2026-10-12,
 * docs/plans/2026-10-12-stages-and-views-refactor.md): `lenses/<id>.json`
 * holds its name, its rule, its cut-off, the servers it is shared with and
 * any review a change nobody made opened, committed as the lens changes.
 * Moving the vault keeps its lenses; losing this computer's settings loses
 * nothing. Server members never see a rule.
 *
 * What is in it is not kept here. The owner's pins, exclusions and ratings,
 * and every scoring pass, are inclusion assertions in the record
 * (lib/assertionLog.ts), and a lens's members are a view over them
 * (lib/views/lens.ts). Each server gets the union of the members of the
 * lenses shared with it (lib/lensSync.ts).
 */
import {existsSync,mkdirSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {commitPathsOnly,gitOut} from './git';
import {ensureDir,writeAtomic} from './fsx';
import {sha256hex} from './hash';
import {LENS_ID,type EnvelopeId} from './ids';
import {sourceDigest,type InclusionLabel} from './inclusionPolicy';

/** A change nobody made to a shared lens that would add notes to it (decision D3). */
export interface LensReview {
 /** A model upgrade, a change in the vault's entities, or a BigBrain update. */
 reason:'model'|'vault'|'update';
 /** Hold additions until someone looks: Conservative mode, and always after an update. */
 hold:boolean;
 /** When it opened; empty while a migrated lens waits for its first pass to say whether anything would join. */
 at:string;
}

export interface Lens {
 id:string;
 name:string;
 /** The rule. */
 text:string;
 /** What the owner last saw the lens scored with: the evaluator's full identity, its model part, the cut-off,
  * and the evaluator version (lib/inclusionEvaluation.ts). A scoring pass under another identity is a change
  * nobody made. */
 calibration:{identity:string;model:string;threshold:number;version?:number};
 /** Connection ids this lens is shared with. */
 servers:string[];
 review?:LensReview;
 version:string;
 created:string;
 updated:string;
}

/** The rule review's scope for a lens (lib/inclusionReview.ts keeps a review's ratings there until the lens is saved). */
export const lensScope=(id:string)=>JSON.stringify(['lens',id]);
export const LENS_DIR='lenses';
const lensRel=(id:string)=>{if(!LENS_ID.test(id))throw Error('Unknown lens.');return `${LENS_DIR}/${id}.json`;};

export function listLenses(root:string):Lens[]{
 const dir=join(root,LENS_DIR);if(!existsSync(dir))return [];
 return readdirSync(dir).filter(f=>/^lens_[a-f0-9]{12}\.json$/.test(f)).map(f=>JSON.parse(readFileSync(join(dir,f),'utf8')) as Lens).sort((a,b)=>a.created.localeCompare(b.created)||a.id.localeCompare(b.id));
}
export function readLens(root:string,id:string):Lens|undefined{const path=join(root,lensRel(id));return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;}

/** Commit a lens's file as the owner changed it. Fail-soft, as every machine commit is: the file is safe on disk. */
function commitLens(root:string,rel:string,message:string){
 if(!gitOut(root,['rev-parse','--git-dir']))return;
 try{commitPathsOnly(root,'lens',message,[rel]);}catch(e){console.error(`lens: commit failed (${rel} is safe on disk): ${e}`);}
}
/** Write a lens's file, and commit it unless `message` is false (the caller commits). The path written. */
export function writeLens(root:string,lens:Lens,message:string|false=`lens: ${lens.name}`):string{
 const rel=lensRel(lens.id);mkdirSync(join(root,LENS_DIR),{recursive:true});writeAtomic(join(root,rel),JSON.stringify(lens,null,1)+'\n');
 if(message!==false)commitLens(root,rel,message);
 return rel;
}
export function removeLens(root:string,id:string){
 const rel=lensRel(id),lens=readLens(root,id);rmSync(join(root,rel),{force:true});if(lens)commitLens(root,rel,`lens: ${lens.name} — deleted`);
}

/** Change one lens and stamp it, so a pass that read the old version can tell. */
export function updateLens(root:string,id:string,change:(lens:Lens)=>void,message?:string):Lens{
 const lens=readLens(root,id);if(!lens)throw Error('This lens no longer exists.');
 change(lens);lens.version=randomUUID();lens.updated=new Date().toISOString();writeLens(root,lens,message);return lens;
}

export function newLens(fields:Pick<Lens,'name'|'text'>&Partial<Lens>):Lens{
 const now=new Date().toISOString();
 return {id:'lens_'+randomBytes(6).toString('hex'),calibration:{identity:'',model:'',threshold:DEFAULT_THRESHOLD},servers:[],version:randomUUID(),created:now,updated:now,...fields};
}

/** Jev's scores sit lower than the old fixed 0.8 assumed: 0.6 agreed with most ratings in E1. */
export const DEFAULT_THRESHOLD=.6;

/** The cut-off that best agrees with the lens's ratings, given each rated note's current score.
 * Ties go to the cut-off nearest the default; with nothing to fit, the default. */
export function fitThreshold(rated:{include:boolean;score:number}[]):number{
 if(!rated.length)return DEFAULT_THRESHOLD;
 let best=DEFAULT_THRESHOLD,bestRight=-1;
 for(let i=6;i<=19;i++){
  const t=i/20,right=rated.filter(r=>(r.score>=t)===r.include).length;
  if(right>bestRight||(right===bestRight&&Math.abs(t-DEFAULT_THRESHOLD)<Math.abs(best-DEFAULT_THRESHOLD))){best=t;bestRight=right;}
 }
 return best;
}

/** The cut-off a preview draws at. An unchanged lens (same rule, same
 * ratings) keeps its own: a migrated lens's came from its server rule, and
 * refitting it from the ratings alone would show notes joining that never
 * will. A new rule or new ratings fit afresh. */
export function previewThreshold(lens:Pick<Lens,'text'|'calibration'>&{labels:InclusionLabel[]}|undefined,text:string,labels:InclusionLabel[],fit:()=>number):number{
 const key=(ls:InclusionLabel[])=>JSON.stringify(ls.map(l=>[sourceDigest(l.source),l.include]));
 return lens&&lens.text===text&&key(lens.labels)===key(labels)?lens.calibration.threshold:fit();
}

/** A personal note as scoring sees it: its latest text and that text's digest (`sourceDigest`). */
export interface LensNote {source_id:EnvelopeId;digest:string;title:string;body:string}

/** The rule's own answer for each note, before pins and exclusions: a
 * rating, else its score against the cut-off; a note with neither is
 * pending, in neither set. What a preview shows. */
export function ruled(ratings:ReadonlyMap<string,boolean>,threshold:number,notes:readonly {source_id:string}[],scores:ReadonlyMap<string,number>):{in:Set<string>;out:Set<string>}{
 const out={in:new Set<string>(),out:new Set<string>()};
 for(const n of notes){
  const rating=ratings.get(n.source_id),score=scores.get(n.source_id);
  const inside=rating!==undefined?rating:score!==undefined?score>=threshold:undefined;
  if(inside!==undefined)(inside?out.in:out.out).add(n.source_id);
 }
 return out;
}

/** The last pass's trouble, in the provider's words: this machine's, kept in `.state/`. */
const errorPath=(root:string,id:string)=>join(root,'.state','lenses',id+'.error');
export function lensError(root:string,id:string):string|undefined{try{return readFileSync(errorPath(root,id),'utf8')||undefined;}catch{return undefined;}}
export function setLensError(root:string,id:string,error:string|undefined){
 if(!error){rmSync(errorPath(root,id),{force:true});return;}
 ensureDir(join(root,'.state','lenses'));writeAtomic(errorPath(root,id),error);
}

/** Sharing mode (decision D3): what a change nobody made does when it would add notes to a shared lens. */
export type SharingMode='conservative'|'yeehaw';
const settingsPath=(store:string)=>join(dirname(store),'lens-settings.json');
export function sharingMode(store:string):SharingMode{
 try{return JSON.parse(readFileSync(settingsPath(store),'utf8')).mode==='yeehaw'?'yeehaw':'conservative';}catch{return 'conservative';}
}
export function setSharingMode(store:string,mode:unknown){
 if(mode!=='conservative'&&mode!=='yeehaw')throw Error('Choose Conservative or Yee-haw.');
 mkdirSync(dirname(settingsPath(store)),{recursive:true,mode:0o700});writeAtomic(settingsPath(store),JSON.stringify({mode}),0o600);return mode;
}

/** Where lenses lived before they moved into the vault: beside the
 * connection store, one directory per vault. `bigbrain migrate` moves them
 * in (lib/lensMigrate.ts); until then the engine leaves them be. */
export const legacyLensDir=(root:string,store:string)=>join(dirname(store),'lenses',sha256hex(root));
