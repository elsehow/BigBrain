import {readAssertionLog,assertionSourceReferences} from './assertionLog';
import {readEntityAliasLog,entityAliasResolution} from './entityAliasLog';
import {parseMentions,type MentionItem} from './pilotMentions';
import type {SourceInsertion} from './insertionLog';
import {plainText} from './v2Feed';
export interface RuleEntity extends MentionItem {aliases:string[];sourceIds:Set<string>;context:string[]}
/** What the gardener read in one note revision: its claims, and the entities they name by their canonical labels. */
export interface NoteClaims {claims:string[];claim_entities:string[]}
// A note's claims go to the evaluator with the note itself (lib/inclusionEvaluation.ts), so they stay short.
const CLAIM_CHARACTERS=2000,CLAIM_ENTITIES=40;
const cache=new Map<string,{at:number;entities:Map<string,RuleEntity>;notes:Map<string,NoteClaims>}>();
/** One read of the claim log: the entities a rule can @mention, and each note revision's claims by insertion id. */
function readClaims(root:string) {
 const cached=cache.get(root);if(cached&&Date.now()-cached.at<30000)return cached;
 const aliases=entityAliasResolution(readEntityAliasLog(root,{strict:true})),items=new Map<string,RuleEntity>(),notes=new Map<string,NoteClaims>(),room=new Map<string,number>();
 for(const a of readAssertionLog(root,{strict:true})){
  const refs=assertionSourceReferences(a),text=plainText(a.text),labels:string[]=[];
  for(const e of a.entities){const canonical=aliases.canonical.get(e.id)??e,path=`projection/entities/${canonical.id}.md`;labels.push(canonical.label);let item=items.get(path);if(!item){item={id:path,title:canonical.label,tag:'ENTITY',aliases:aliases.labels.get(canonical.id)??[],sourceIds:new Set(),context:[]};items.set(path,item);}for(const ref of refs)item.sourceIds.add(ref.insertion_id);if(item.context.length<25)item.context.push(a.text.slice(0,1600));}
  for(const {insertion_id} of refs){
   let note=notes.get(insertion_id);if(!note){note={claims:[],claim_entities:[]};notes.set(insertion_id,note);}
   const left=room.get(insertion_id)??CLAIM_CHARACTERS;if(text.length<=left){note.claims.push(text);room.set(insertion_id,left-text.length);}
   for(const label of labels)if(note.claim_entities.length<CLAIM_ENTITIES&&!note.claim_entities.includes(label))note.claim_entities.push(label);
  }
 }
 const read={at:Date.now(),entities:items,notes};cache.set(root,read);return read;
}
const entities=(root:string)=>readClaims(root).entities;
/** Each note revision's claims, by insertion id. */
export const noteClaims=(root:string):ReadonlyMap<string,NoteClaims>=>readClaims(root).notes;
export function searchRuleEntities(root:string,q:string):MentionItem[]{const words=q.toLowerCase().trim().split(/\s+/);return [...entities(root).values()].filter(e=>words.every(w=>[e.title,...e.aliases].some(label=>label.toLowerCase().includes(w)))).sort((a,b)=>a.title.localeCompare(b.title)).slice(0,30).map(({id,title,tag})=>({id,title,tag}));}
export function resolveRuleMentions(root:string,text:string) {
 const parts=parseMentions(text),known=entities(root),mentioned:RuleEntity[]=[];
 for(const part of parts){if('mention' in part){const entity=known.get(part.mention.id);if(!entity)throw Error('A mentioned entity is no longer available. Select it again.');mentioned.push(entity);}else if(/(^|\s)@[\p{L}]/u.test(part.text))throw Error('Select @mentions from the vault suggestions before saving or testing.');}
 return mentioned;
}
export function ruleCandidateFilter(root:string,text:string):(source:SourceInsertion)=>boolean {
 // Only optimize the explicit "Sources that mention <entity>." grammar.
 // Other natural-language instructions are evaluated without narrowing.
 const match=/^Sources that mention (\[\[[^\]]+\]\])\./i.exec(text);
 if(!match)return ()=>true;
 const entity=resolveRuleMentions(root,match[1]!)[0];if(!entity)return ()=>true;
 const labels=[entity.title,...entity.aliases].filter(Boolean).map(s=>s.toLowerCase());
 return s=>entity.sourceIds.has(s.id)||labels.some(label=>(s.title+'\n'+s.body).toLowerCase().includes(label));
}
export function ruleMentionContext(root:string,text:string){return resolveRuleMentions(root,text).map(({id,title,aliases,context})=>({id,title,aliases,context}));}
