import {readAssertionLog,assertionSourceReferences} from './assertionLog';
import {readEntityAliasLog,entityAliasResolution} from './entityAliasLog';
import {parseMentions,type MentionItem} from './pilotMentions';
import type {SourceInsertion} from './insertionLog';
const cache=new Map<string,{at:number;entities:Map<string,RuleEntity>}>();
export interface RuleEntity extends MentionItem {aliases:string[];sourceIds:Set<string>;context:string[]}
function entities(root:string) {
 const cached=cache.get(root);if(cached&&Date.now()-cached.at<30000)return cached.entities;
 const aliases=entityAliasResolution(readEntityAliasLog(root,{strict:true})),items=new Map<string,RuleEntity>();
 for(const a of readAssertionLog(root,{strict:true}))for(const e of a.entities){const canonical=aliases.canonical.get(e.id)??e,path=`projection/entities/${canonical.id}.md`;let item=items.get(path);if(!item){item={id:path,title:canonical.label,tag:'ENTITY',aliases:aliases.labels.get(canonical.id)??[],sourceIds:new Set(),context:[]};items.set(path,item);}for(const ref of assertionSourceReferences(a))item.sourceIds.add(ref.insertion_id);if(item.context.length<25)item.context.push(a.text.slice(0,1600));}
 cache.set(root,{at:Date.now(),entities:items});return items;
}
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
