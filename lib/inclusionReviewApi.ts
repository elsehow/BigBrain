import type {IncomingMessage,ServerResponse} from 'node:http';
import {json,readBody} from './httpx';
import {allowVaultRequest,vaultIdentity} from './vaultBoundary';
import {connectionStorePath} from './sharedConnections';
import type {InclusionSource} from './inclusionPolicy';
import {lensNotes} from './lensScoring';
import {lensScope,readLens} from './lenses';
import {getReview,startReview,reviewState,rateReview,pickReview,searchReviewSources,editReview,retryReview,finishReview,type ReviewContext} from './inclusionReview';
import {ruleCandidateFilter,searchRuleEntities} from './sharedRuleMentions';
import {ruleQueries} from './inclusionQueries';
export async function inclusionReviewApi(req:IncomingMessage,res:ServerResponse,root:string){
 const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith('/api/inclusion-review'))return false;
 if(!allowVaultRequest(req,res,vaultIdentity(root)))return true;
 const store=connectionStorePath(),action=url.pathname.split('/').at(-1);
 try{
  if(req.method==='GET'&&action==='entities'){json(res,200,{items:searchRuleEntities(root,url.searchParams.get('q')??'')});return true;}
  if(req.method==='GET'&&action==='sources'){json(res,200,{items:searchReviewSources(getReview(root,url.searchParams.get('id')??''),url.searchParams.get('q')??'')});return true;}
  if(req.method==='GET'){json(res,200,reviewState(getReview(root,url.searchParams.get('id')??'')));return true;}
  if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
  const body=JSON.parse(await readBody(req,20000));
  if(action==='start'){
   // A lens's rule, reviewed over the whole vault; saving the lens happens in Edit a lens (lib/lensApi.ts).
   const target=body.target;if(target?.kind!=='lens'||typeof target.id!=='string'||!/^lens_[a-f0-9]{12}$/.test(target.id))throw Error('Choose a lens.');
   const notes=()=>lensNotes(root).reverse();
   const asSource=(n:ReturnType<typeof lensNotes>[number]):InclusionSource=>({id:n.insertion.id,title:n.title,body:n.body,origin:['Personal',(n.insertion.received_at??'').slice(0,10)].filter(Boolean).join(' · ')});
   const lens=readLens(root,store,target.id);
   const context:ReviewContext={root,store,scope:lensScope(target.id),text:body.text??lens?.text??'',labels:lens?.labels,sources:notes().map(asSource),
    select:text=>{const keep=ruleCandidateFilter(root,text);return notes().filter(n=>keep(n.insertion)).map(asSource);},check:()=>{},save:()=>{}};
   if(typeof context.text!=='string'||!context.text.trim()||context.text.length>8000)throw Error('Write an inclusion rule first.');
   context.queries=(text,entities)=>ruleQueries(root,store,text,entities);
   json(res,202,startReview(context));return true;
  }
  const s=getReview(root,body.id);
  if(action==='rate')json(res,200,rateReview(s,body.source,body.include,body.revision));
  else if(action==='pick')json(res,200,pickReview(s,body.source,body.revision));
  else if(action==='edit')json(res,202,editReview(s,body.text,body.revision));
  else if(action==='retry')json(res,202,retryReview(s));
  else if(action==='finish')json(res,200,finishReview(s));
  else json(res,404,{error:'Not found'});
 }catch(e){json(res,400,{error:e instanceof Error?e.message:'Could not review inclusion rule.'});}
 return true;
}
