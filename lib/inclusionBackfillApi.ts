import type {IncomingMessage,ServerResponse} from 'node:http';
import {json,readBody} from './httpx';
import {allowVaultRequest,vaultIdentity} from './vaultBoundary';
import {connectionStorePath,readConnections} from './sharedConnections';
import {addBackfill,assertCanContribute,backfillState,getBackfill,rateBackfill,startBackfill} from './inclusionBackfill';
/** /api/inclusion-backfill — add a shared vault's EXISTING matches (lib/inclusionBackfill.ts).
 *   POST start {connection}   GET ?id=   POST rate {id, source, include}   POST add {id} */
export async function inclusionBackfillApi(req:IncomingMessage,res:ServerResponse,root:string){
 const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith('/api/inclusion-backfill'))return false;
 if(!allowVaultRequest(req,res,vaultIdentity(root)))return true;
 const store=connectionStorePath(),action=url.pathname.split('/').at(-1);
 try{
  if(req.method==='GET'){json(res,200,backfillState(getBackfill(root,url.searchParams.get('id')??'')));return true;}
  if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
  const body=JSON.parse(await readBody(req,20000)) as {connection?:unknown;id?:unknown;source?:unknown;include?:unknown};
  if(action==='start'){
   const c=readConnections(store).find(x=>x.id===body.connection);if(!c)throw Error('Shared connection unavailable.');
   await assertCanContribute(c);json(res,202,await startBackfill(root,store,c));return true;
  }
  const b=getBackfill(root,String(body.id??''));
  if(action==='rate')json(res,200,rateBackfill(b,String(body.source??''),body.include as boolean));
  else if(action==='add')json(res,200,await addBackfill(b));
  else json(res,404,{error:'Not found'});
 }catch(e){json(res,400,{error:e instanceof Error?e.message:'Could not add existing matches.'});}
 return true;
}
