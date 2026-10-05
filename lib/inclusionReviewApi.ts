import type {IncomingMessage,ServerResponse} from 'node:http';
import {json,readBody} from './httpx';
import {allowVaultRequest,vaultIdentity} from './vaultBoundary';
import {connectionStorePath,readConnections,sharedRequest} from './sharedConnections';
import {contributions,getRule,setRule,sourceKey} from './sharedRules';
import {readSourceInsertionLog} from './insertionLog';
import {sharedRuleScope,type InclusionSource} from './inclusionPolicy';
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
   const target=body.target;let context:ReviewContext;
   if(target?.kind==='shared'){
    const c=readConnections(store).find(c=>c.id===target.id);if(!c)throw Error('Shared connection unavailable.');
    const who=await sharedRequest<{permissions:string[]}>(c,'/v1/whoami');if(!who.permissions.includes('write'))throw Error('This shared vault is read-only.');
    const version=getRule(store,c.id)?.version;
    const check=()=>{if(!readConnections(store).some(x=>x.id===c.id&&x.token===c.token)||getRule(store,c.id)?.version!==version)throw Error('The shared connection or rule changed. Reopen its review.');};
    // "Include these?" asks only about notes not yet in the shared vault, whatever their age.
    const shared=new Set((await contributions(c)).map(x=>x.source_id));
    const unshared=()=>{const all=new Map<string,ReturnType<typeof readSourceInsertionLog>[number]>();for(const s of readSourceInsertionLog(root,{strict:true}))all.set(s.source_id,s);return [...all.values()].reverse().filter(s=>!shared.has('origin:'+sourceKey(s)));};
    const asSource=(s:ReturnType<typeof readSourceInsertionLog>[number]):InclusionSource=>({id:s.id,title:s.title,body:s.body,origin:`Personal · ${(s.received_at??'').slice(0,10)}`});
    context={root,store,scope:sharedRuleScope(c.id),text:body.text??getRule(store,c.id)?.text??'',sources:unshared().map(asSource),select:text=>unshared().filter(ruleCandidateFilter(root,text)).map(asSource),check,save:text=>setRule(store,c.id,text,root)};
   }else throw Error('Choose a shared vault.');
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
