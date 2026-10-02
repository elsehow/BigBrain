import type {IncomingMessage,ServerResponse} from 'node:http';
import {json,readBody} from './httpx';
import {allowVaultRequest,vaultIdentity} from './vaultBoundary';
import {connectionStorePath,readConnections,sharedRequest} from './sharedConnections';
import {getRule,setRule} from './sharedRules';
import {readSourceInsertionLog} from './insertionLog';
import {stageItemsForReview} from './inclusionStages';
import {accountPolicy,writeAccountPolicy,integrationAccounts,MANAGED_INTEGRATIONS,accountFingerprint} from './integrationAccess';
import {sharedRuleScope,integrationRuleScope,type InclusionSource} from './inclusionPolicy';
import {getReview,startReview,reviewState,rateReview,editReview,retryReview,finishReview,type ReviewContext} from './inclusionReview';
import {ruleCandidateFilter,searchRuleEntities} from './sharedRuleMentions';
import {ruleQueries} from './inclusionQueries';
export async function inclusionReviewApi(req:IncomingMessage,res:ServerResponse,root:string){
 const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith('/api/inclusion-review'))return false;
 if(!allowVaultRequest(req,res,vaultIdentity(root)))return true;
 const store=connectionStorePath(),action=url.pathname.split('/').at(-1);
 try{
  if(req.method==='GET'&&action==='entities'){json(res,200,{items:searchRuleEntities(root,url.searchParams.get('q')??'')});return true;}
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
    const latest=new Map<string,ReturnType<typeof readSourceInsertionLog>[number]>();for(const s of readSourceInsertionLog(root,{strict:true}))latest.set(s.source_id,s);
    const sources:InclusionSource[]=[...latest.values()].reverse().map(s=>({id:s.id,title:s.title,body:s.body,origin:`Personal · ${(s.received_at??'').slice(0,10)}`}));
    context={root,store,scope:sharedRuleScope(c.id),text:body.text??getRule(store,c.id)?.text??'',sources,select:text=>{const all=new Map<string,ReturnType<typeof readSourceInsertionLog>[number]>();for(const s of readSourceInsertionLog(root,{strict:true}))all.set(s.source_id,s);return [...all.values()].reverse().filter(ruleCandidateFilter(root,text)).map(s=>({id:s.id,title:s.title,body:s.body,origin:`Personal · ${(s.received_at??'').slice(0,10)}`}));},check,save:text=>setRule(store,c.id,text,root)};
   }else if(target?.kind==='integration'){
    const {name,account}=target;if(!MANAGED_INTEGRATIONS.has(name)||!integrationAccounts(root,name).includes(account))throw Error('Choose a configured integration account.');
    const prior=accountPolicy(root,name,account),fingerprint=accountFingerprint(root,name,account);
    if(!prior.connected)throw Error('Connect this account before reviewing its rule.');
    const check=()=>{if(!accountPolicy(root,name,account).connected||accountFingerprint(root,name,account)!==fingerprint||accountPolicy(root,name,account).remembering.rule!==prior.remembering.rule)throw Error('Account or rule changed. Reopen its review.');};
    context={root,store,scope:integrationRuleScope(name,account),text:body.text??prior.remembering.rule,sources:stageItemsForReview(root,name,account),select:()=>stageItemsForReview(root,name,account),check,save:text=>{const p=accountPolicy(root,name,account);writeAccountPolicy(root,name,account,{...p,remembering:{...p.remembering,rule:text}});}};
   }else throw Error('Choose a shared vault or integration.');
   if(typeof context.text!=='string'||!context.text.trim()||context.text.length>8000)throw Error('Write an inclusion rule first.');
   context.queries=(text,entities)=>ruleQueries(root,store,text,entities);
   json(res,202,startReview(context));return true;
  }
  const s=getReview(root,body.id);
  if(action==='rate')json(res,200,rateReview(s,body.source,body.include,body.revision));
  else if(action==='edit')json(res,202,editReview(s,body.text,body.revision));
  else if(action==='retry')json(res,202,retryReview(s));
  else if(action==='finish')json(res,200,finishReview(s));
  else json(res,404,{error:'Not found'});
 }catch(e){json(res,400,{error:e instanceof Error?e.message:'Could not review inclusion rule.'});}
 return true;
}
