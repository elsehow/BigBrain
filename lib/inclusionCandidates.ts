import {parseMentions} from './pilotMentions';
import type {InclusionSource} from './inclusionPolicy';
// Rule grammar, not topic: "include everything that has to do with…" says nothing about which sources fit.
const RULE_WORDS=new Set('include includes including exclude excludes excluding everything anything something things items sources source mention mentions mentioned only that this these those with have has from about what which where when they them their there should would could want know like just also into more other some such than then will your ours mine very much'.split(' '));
const stem=(w:string)=>w.length>6?w.slice(0,6):w;
const words=(text:string,keep=false)=>new Set((text.toLowerCase().match(/[\p{L}]{4,}/gu)??[]).filter(w=>keep||!RULE_WORDS.has(w)).map(stem));
export interface CandidateEntity {title:string;aliases:string[];sourceIds:Set<string>}
/** Orders review candidates by lexical fit to the rule so paid scoring starts with plausible matches.
 * Sources linked to a mentioned entity lead; the rest keep their incoming (recency) order.
 * `phrases` (lib/inclusionQueries.ts) are search terms a model derived from the rule: their words
 * count even when the rule's grammar list would drop them ("will"), and a whole phrase scores more. */
export function rankCandidates(sources:InclusionSource[],rule:string,entities:CandidateEntity[]=[],phrases:string[]=[]):InclusionSource[]{
 const terms=new Set([...words(parseMentions(rule).map(p=>'text' in p?p.text:'').join(' ')),...phrases.flatMap(p=>[...words(p,true)])]);
 const multi=phrases.filter(p=>/\s/.test(p));
 const labels=entities.map(e=>[e.title,...e.aliases].filter(l=>l.length>2).map(l=>l.toLowerCase()));
 const docs=sources.map(s=>{const text=(s.title+'\n'+s.body.slice(0,20000)).toLowerCase();return {s,text,title:words(s.title,true),all:words(text,true)};});
 const df=new Map<string,number>();for(const d of docs)for(const t of terms)if(d.all.has(t))df.set(t,(df.get(t)??0)+1);
 const idf=(t:string)=>Math.log(1+docs.length/(1+(df.get(t)??0)));
 // A long transcript holds a little of every word: damp lexical fit by length past the typical
 // source, so a note about the topic outranks a session that mentions it in passing.
 const lengths=docs.map(d=>d.text.length).sort((a,b)=>a-b),typical=Math.max(1,lengths[Math.floor(lengths.length/2)]??1);
 const scored=docs.map(({s,text,title,all},index)=>{
  let score=0;for(const t of terms)if(all.has(t))score+=idf(t)*(title.has(t)?2:1);
  for(const p of multi)if(text.includes(p))score+=4;
  score/=1+Math.max(0,Math.log(text.length/typical));
  entities.forEach((e,i)=>{if(e.sourceIds.has(s.id))score+=10;else if(labels[i]!.some(l=>text.includes(l)))score+=6;});
  return {s,score,index};
 });
 return scored.sort((a,b)=>b.score-a.score||a.index-b.index).map(r=>r.s);
}
