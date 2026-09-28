/** Reconstruct discovery outcomes from ordinary evidence, pending items and
 * pass outcomes. No parallel email memory store; cache deletion is harmless. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSourceInsertionLog } from './insertionLog';
import { stagedHeads, openStaged } from './stage';
import { sha256hex } from './hash';
import { parseEnvelope } from './envelope';
import type { Head } from './emailItem';
export function emailDiscovered(root:string) {
  const ids=new Set<string>(), legacy=new Set<string>();
  const take=(e:Record<string,unknown>,body:string)=>{
    if(e.source!=='email')return;
    if(typeof e.id==='string')ids.add(e.id);
    if(!e.provider_message_id&&typeof e.inbox==='string'&&typeof e.message_id==='string'&&e.message_id)legacy.add(JSON.stringify([e.inbox,e.message_id,sha256hex(body.trim())]));
  };
  for(const e of readSourceInsertionLog(root)) { ids.add(e.source_id);take(e.envelope,e.body); }
  for(const h of stagedHeads(root,Infinity).filter(h=>h.source==='email')) {
    ids.add(h.id);
    for(const item of openStaged(root,[h.id]))if('content' in item && !item.truncated){const parsed=parseEnvelope(item.content);take(parsed.envelope,parsed.body);}
  }
  try { for(const line of readFileSync(join(root,'.spool','stage','passed.jsonl'),'utf8').split('\n').filter(Boolean)){const item=JSON.parse(line);if(item.source==='email')ids.add(item.id);} }
  catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e; }
  return (h:Head,id:string,content?:string)=>ids.has(id)||(!!content&&legacy.has(JSON.stringify([h.inbox,h.messageId,sha256hex(parseEnvelope(content).body.trim())])));
}
