import type {InclusionLabel} from './inclusionPolicy';
/** Display/prompt context only; the candidate itself is always evaluated in full. */
export function inclusionExcerpt(body:string,limit=420){
 return body.replace(/^---\n[\s\S]*?\n---\s*/,'').split('\n').filter(line=>!/^\s*(#|Session\s|---\s*TRANSCRIPT|a\d{8}|ISSN|ISBN)/i.test(line)&&!/^\s*`?\/Users\//.test(line)).join(' ').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim().slice(0,limit);
}
export function teachingExamples(labels:InclusionLabel[],source:{title:string;body:string}){
 const words=new Set((source.title+' '+source.body.slice(0,4000)).toLowerCase().match(/[a-z]{4,}/g)??[]);
 const rows=labels.filter(l=>l.source.title!==source.title||l.source.body!==source.body).map((label,index)=>({label,index,similarity:(label.source.title+' '+label.source.body.slice(0,4000)).toLowerCase().match(/[a-z]{4,}/g)?.filter(w=>words.has(w)).length??0}));
 rows.sort((a,b)=>b.similarity-a.similarity||b.index-a.index);
 const chosen=[...rows.filter(r=>r.label.include).slice(0,3),...rows.filter(r=>!r.label.include).slice(0,3)];
 return chosen.map(({label})=>({title:label.source.title,excerpt:inclusionExcerpt(label.source.body,1800),include:label.include}));
}
export type TeachingExample=ReturnType<typeof teachingExamples>[number];
