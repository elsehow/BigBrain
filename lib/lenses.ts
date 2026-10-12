/**
 * lenses.ts — a lens is a named rule over this vault, plus the notes added or
 * removed by hand (docs/plans/lenses-and-servers.md). Lenses are yours: each
 * is one file beside the connection credentials, never in a vault and never
 * on a server, and its rule never leaves this computer. A lens can be shared
 * with servers; each server gets the union of the members of the lenses
 * shared with it (lib/lensSync.ts).
 *
 * Membership is exact. A note's place in a lens is decided, in order, by a
 * hand edit (a removal, then an addition), by a rating given while reviewing
 * the rule, and otherwise by its score against the lens's cut-off. Hand edits
 * decide their own notes and teach the evaluator nothing; ratings do both.
 * A note that could not be scored keeps whatever place it had.
 */
import {existsSync,mkdirSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeAtomic} from './fsx';
import {sha256hex} from './hash';
import {sourceDigest,type InclusionLabel} from './inclusionPolicy';

/** A change nobody made to the lens that would add notes to it (decision D3). */
export interface LensReview {
 /** A model upgrade, a change in the vault's entities, or this app's move from server rules to lenses. */
 reason:'model'|'vault'|'update';
 /** Hold additions until someone looks: Conservative mode, and always after the update. */
 hold:boolean;
 /** Personal source ids the change adds, and those it took out. */
 joins:string[];
 leaves:string[];
 at:string;
}

export interface Lens {
 id:string;
 name:string;
 /** The rule. */
 text:string;
 /** Ratings from reviewing the rule: they teach the evaluator and decide their own notes. */
 labels:InclusionLabel[];
 /** Personal source ids added or removed by hand. */
 pins:string[];
 exclusions:string[];
 /** What the members were scored with: the evaluator's full identity, its model part, the cut-off, and the evaluator version (lib/inclusionEvaluation.ts), which lenses scored before version 3 lack. */
 calibration:{identity:string;model:string;threshold:number;version?:number};
 /** Connection ids this lens is shared with. */
 servers:string[];
 /** The membership last applied, by personal source id. */
 members:string[];
 /** Members judged from a summary, the note being too big to read whole (decision D8). */
 summarized:string[];
 review?:LensReview;
 /** The last pass's trouble, in the provider's words; cleared by a clean pass. */
 error?:string;
 version:string;
 created:string;
 updated:string;
}

/** The rule review's scope for a lens (lib/inclusionReview.ts keeps a review's ratings there until the lens is saved). */
export const lensScope=(id:string)=>JSON.stringify(['lens',id]);
/** Where a vault's lenses live: beside the connection store, per vault. */
export const lensDir=(root:string,store:string)=>join(dirname(store),'lenses',sha256hex(root));
const lensPath=(root:string,store:string,id:string)=>{if(!/^lens_[a-f0-9]{12}$/.test(id))throw Error('Unknown lens.');return join(lensDir(root,store),id+'.json');};

export function listLenses(root:string,store:string):Lens[]{
 const dir=lensDir(root,store);if(!existsSync(dir))return [];
 return readdirSync(dir).filter(f=>/^lens_[a-f0-9]{12}\.json$/.test(f)).map(f=>JSON.parse(readFileSync(join(dir,f),'utf8')) as Lens).sort((a,b)=>a.created.localeCompare(b.created)||a.id.localeCompare(b.id));
}
export function readLens(root:string,store:string,id:string):Lens|undefined{const path=lensPath(root,store,id);return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;}
export function writeLens(root:string,store:string,lens:Lens){const path=lensPath(root,store,lens.id);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeAtomic(path,JSON.stringify(lens),0o600);}
export function removeLens(root:string,store:string,id:string){rmSync(lensPath(root,store,id),{force:true});}

/** Change one lens and stamp it, so a pass that read the old version can tell. */
export function updateLens(root:string,store:string,id:string,change:(lens:Lens)=>void):Lens{
 const lens=readLens(root,store,id);if(!lens)throw Error('This lens no longer exists.');
 change(lens);lens.version=randomUUID();lens.updated=new Date().toISOString();writeLens(root,store,lens);return lens;
}

export function newLens(fields:Pick<Lens,'name'|'text'>&Partial<Lens>):Lens{
 const now=new Date().toISOString();
 return {id:'lens_'+randomBytes(6).toString('hex'),labels:[],pins:[],exclusions:[],calibration:{identity:'',model:'',threshold:DEFAULT_THRESHOLD},servers:[],members:[],summarized:[],version:randomUUID(),created:now,updated:now,...fields};
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
export function previewThreshold(lens:Pick<Lens,'text'|'labels'|'calibration'>|undefined,text:string,labels:InclusionLabel[],fit:()=>number):number{
 const key=(ls:InclusionLabel[])=>JSON.stringify(ls.map(l=>[sourceDigest(l.source),l.include]));
 return lens&&lens.text===text&&key(lens.labels)===key(labels)?lens.calibration.threshold:fit();
}

/** A personal note as lenses see it: its latest text and that text's digest (`sourceDigest`). */
export interface LensNote {source_id:string;digest:string;title:string;body:string}
/** The lens's members for these notes. `scores` has a score for each note that could be scored. */
export function membership(lens:Pick<Lens,'labels'|'pins'|'exclusions'|'members'|'calibration'>,notes:LensNote[],scores:ReadonlyMap<string,number>):Set<string>{
 const pins=new Set(lens.pins),exclusions=new Set(lens.exclusions),was=new Set(lens.members);
 const rated=new Map(lens.labels.map(l=>[sourceDigest(l.source),l.include]));
 const out=new Set<string>();
 for(const n of notes){
  const label=rated.get(n.digest),score=scores.get(n.source_id);
  const inside=exclusions.has(n.source_id)?false:pins.has(n.source_id)?true:label!==undefined?label:score!==undefined?score>=lens.calibration.threshold:was.has(n.source_id);
  if(inside)out.add(n.source_id);
 }
 return out;
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
