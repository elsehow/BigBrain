/** Granola revision equality and admission. seq is LOCAL observation order,
 * not a provider version: MCP exposes no documented revision clock. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spoolDir} from './spool';
import {parseEnvelope,serializeEnvelope,type Envelope} from './envelope';
import {sha256hex} from './hash';
import {openAssertionProjectionReadonly,syncAssertionProjection} from './assertionProjection';
import {insertionEventOnDisk,type SourceInsertion} from './insertionLog';
import {withProjectionWrite} from './projectionWriteLock';
import {admit} from './door';
import type {IntakeReceipt} from './intake';

export interface GranolaRevision {stream:string;key:string;hash:string;seq:number;id:string}
export function isGranolaMcpContent(content:string):boolean {
 const e=parseEnvelope(content).envelope;
 return e.source==='granola'&&typeof e.stream==='string'&&/^granola:[a-f0-9]{20}$/.test(e.stream);
}
export function granolaRevision(content:string):GranolaRevision {
 const {envelope,body}=parseEnvelope(content);
 return revision(envelope,body);
}
function revision(e:Envelope,body:string):GranolaRevision {
 if(e.source!=='granola'||typeof e.stream!=='string'||!/^granola:[a-f0-9]{20}$/.test(e.stream)||typeof e.key!=='string'||!e.key||typeof e.id!=='string')throw Error('Invalid Granola revision identity.');
 // Exclude generated receipt/observation fields; include discussable metadata.
 const hash=sha256hex(JSON.stringify([e.stream,e.key,e.title??'',e.date??'',e.url??'',body.trim()]));
 return {stream:e.stream,key:e.key,hash,seq:Number.isSafeInteger(e.seq)&&Number(e.seq)>0?Number(e.seq):0,id:e.id};
}
export function granolaHistory(root:string,r:GranolaRevision):{event:SourceInsertion;revision:GranolaRevision}[] {
 syncAssertionProjection(root);
 const db=openAssertionProjectionReadonly(root);
 try {
  const rows=db.query(`SELECT event_json FROM sources WHERE present = 1
   AND json_extract(event_json, '$.envelope.stream') = ?
   AND json_extract(event_json, '$.envelope.key') = ?
   ORDER BY coalesce(received_at, occurred_at, ''), insertion_id`).all(r.stream,r.key) as {event_json:string}[];
  return rows.map(row=>JSON.parse(row.event_json) as SourceInsertion)
   .filter(event=>insertionEventOnDisk(root,event))
   .map(event=>({event,revision:revision(event.envelope,event.body)}));
 }finally{db.close();}
}
/** Resolve links at admission, under the same lock used by projection writes.
 * No poller is allowed to admit content on the gardener's behalf. */
export function receiveStagedGranola(root:string,content:string):Pick<IntakeReceipt,'id'|'insertionId'> {
 return withProjectionWrite(root,()=>{
  const r=granolaRevision(content),history=granolaHistory(root,r);
  const duplicate=history.find(h=>h.revision.hash===r.hash);
  if(duplicate)return {id:duplicate.event.source_id,insertionId:duplicate.event.id};
  const head=history.reduce<typeof history[number]|undefined>((best,h)=>!best||h.revision.seq>=best.revision.seq?h:best,undefined);
  if(head&&r.seq<=head.revision.seq)throw Error('A later-observed Granola revision is already admitted; pass this older pending revision.');
  const {envelope,body}=parseEnvelope(content);
  const {supersedes:_prior,...meta}=envelope;
  // Preserve the existing source identity for legacy MCP insertions. Never rewrite history.
  const id=head?.event.source_id??r.stream+':'+r.key;
  return admit({root,raw:r.stream+'\n'+r.key+'\n'+r.hash,content:serializeEnvelope({...meta,id,...(head?{supersedes:head.event.id}:{})},body)});
 });
}

/** Pass decisions are durable operational data, not a rebuildable cursor.
 * Older records only identify the staged item; newer ones also carry equality
 * and observation metadata. Neither stores another copy of meeting content. */
export function granolaPasses(root:string):{id:string;revision?:GranolaRevision}[] {
 const records:{id:string;revision?:GranolaRevision}[]=[];
 for(const file of ['passed.jsonl','passed-legacy.jsonl']){
  let text:string;
  try{text=readFileSync(join(spoolDir(root),'stage',file),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  for(const line of text.split('\n').filter(l=>l.trim())){
   const value=JSON.parse(line);
   if(typeof value.id!=='string'||typeof value.source!=='string')throw Error('Invalid integration pass audit.');
   if(value.source!=='granola')continue;
   const v=value.revision;
   if(v&&(typeof v.stream!=='string'||typeof v.key!=='string'||typeof v.hash!=='string'||!Number.isSafeInteger(v.seq)||v.seq<0))throw Error('Invalid Granola pass revision.');
   records.push(value);
  }
 }
 return records;
}
