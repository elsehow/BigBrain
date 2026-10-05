/** Recover observations from durable pending items, pass decisions and the
 * insertion log. The cursor is only a polling optimization. */
import {parseEnvelope,serializeEnvelope} from './envelope';
import {granolaHistory,granolaRevision,isGranolaMcpContent,granolaPasses} from './granolaRevision';
import {stagedItems} from './stage';
import {clear,holdCleared} from './door';
import {integrationActive} from './integrationAccess';
import {withProjectionWrite} from './projectionWriteLock';
import {sha256hex} from './hash';

export async function stageGranolaContent(root:string,account:string,content:string):Promise<boolean> {
 // Screened before the lock: a network call cannot happen under it.
 const cleared=await clear(root,'granola',content);
 if(!cleared)return false;
 return withProjectionWrite(root,()=>{
  if(!integrationActive(root,'granola',account))throw Error('Granola is not connected.');
  const r=granolaRevision(content),history=granolaHistory(root,r);
  const pending=stagedItems(root,'granola').filter(item=>(item.account??'granola')===account&&isGranolaMcpContent(item.content)).map(item=>granolaRevision(item.content));
  const passed=granolaPasses(root);
  const observed=[...history.map(h=>h.revision),...pending,...passed.flatMap(p=>p.revision?[p.revision]:[])]
   .filter(p=>p.stream===r.stream&&p.key===r.key);
  if(observed.some(p=>p.hash===r.hash))return false;
  // Honor pre-upgrade pass decisions, whose audit records contain only the old staged id.
  const legacyId='granola-'+sha256hex(account+'\n'+content).slice(0,32);
  const seq=observed.reduce((max,p)=>Math.max(max,p.seq),0)+1;
  if(!Number.isSafeInteger(seq))throw Error('Granola observation sequence exhausted.');
  const {envelope,body}=parseEnvelope(content);
  const id='granola-'+sha256hex(account+'\n'+r.stream+'\n'+r.key+'\n'+r.hash).slice(0,32);
  if(passed.some(p=>p.id===id||p.id===legacyId))return false;
  return holdCleared(cleared,root,{id,source:'granola',account,at:String(envelope.date),line:String(envelope.title??r.key).slice(0,1000),name:id+'.md',
   content:serializeEnvelope({...envelope,id:r.stream+':'+r.key,seq},body)});
 });
}
