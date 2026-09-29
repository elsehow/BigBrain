import {readSourceInsertionLog,insertionEventRel} from './insertionLog';
import {jevSettingsStatus} from './jevSettings';
import {sourceKey} from './sharedRules';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {json,readBody} from './httpx';
import {allowVaultRequest,vaultIdentity} from './vaultBoundary';
import {connectionStorePath,readConnections,publicConnection,refreshConnectionNames,connectInvite,sharedRequest} from './sharedConnections';
import {serializeMentions,type MentionPart} from './pilotMentions';
import {searchRuleEntities} from './sharedRuleMentions';
import {contributions,getRule,setRule,startTest,testView,importTest} from './sharedRules';
export async function sharedSettingsApi(req:IncomingMessage,res:ServerResponse,root:string) {
 const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith('/api/shared-settings'))return false;
 if(!allowVaultRequest(req,res,vaultIdentity(root)))return true;
 const store=connectionStorePath();
 try{
  if(url.pathname==='/api/shared-settings') {
   if(req.method==='GET'){json(res,200,{connections:await refreshConnectionNames(store)});return true;}
   if(req.method==='POST'){const input=JSON.parse(await readBody(req,16384));json(res,201,await connectInvite(store,input.invite));return true;}
  }
  if(url.pathname==='/api/shared-settings/entities'&&req.method==='GET'){json(res,200,{items:searchRuleEntities(root,url.searchParams.get('q')??'')});return true;}
  const c=readConnections(store).find(c=>c.id===url.searchParams.get('connection'));if(!c){json(res,404,{error:'Shared connection not found'});return true;}
  const action=url.pathname.split('/').at(-1);
  if(req.method==='GET'&&action==='vault'){
   const local=new Map(readSourceInsertionLog(root,{strict:true}).map(s=>['origin:'+sourceKey(s),insertionEventRel(s)]));
   const items=(await contributions(c)).map(item=>({...item,path:local.get(item.source_id)??`shared/${c.id}/${item.insertion_id}.md`}));
   json(res,200,{...publicConnection(c),identity:await sharedRequest(c,'/v1/whoami'),rule:getRule(store,c.id),evaluator:jevSettingsStatus(store).evaluator,items});
  }
  else if(req.method==='GET'&&action==='test'){const result=testView(url.searchParams.get('id')??'',c.id);json(res,result?200:404,result??{error:'Test expired'});}
  else if(req.method==='POST') {
   const body=JSON.parse(await readBody(req,100000));
   if(action==='recommendation') {
    const who=await sharedRequest<{vault:{recommended_rules?:{id:string;text:string;mentions:string[]}[]}}>(c,'/v1/whoami');
    const recommendation=who.vault.recommended_rules?.find(r=>r.id===body.id);if(!recommendation)throw Error('Suggested rule unavailable');
    let text=recommendation.text;
    for(const label of recommendation.mentions){const hits=searchRuleEntities(root,label).filter(e=>e.title.toLowerCase()===label.toLowerCase());if(hits.length!==1)throw Error(`Select @${label} from your vault before using this suggestion.`);text=text.replaceAll('@'+label,serializeMentions([{mention:hits[0]!}] as MentionPart[]));}
    json(res,200,{text});
   }
   else if(action==='rule')json(res,200,{rule:setRule(store,c.id,body.text,root)});
   else if(action==='test')json(res,202,startTest(root,store,c,body.text,body.since??''));
   else if(action==='import')json(res,200,await importTest(root,store,c,body.test,body.ids));
   else if(action==='withdraw'||action==='restore') {
    if(typeof body.id!=='string'||!/^sc_[a-f0-9]{24}$/.test(body.id))throw Error('Invalid contribution');
    json(res,200,await sharedRequest(c,`/v1/contributions/${body.id}/${action}`,{request_id:body.request_id,version:body.version}));
   }else json(res,404,{error:'Not found'});
  }else json(res,405,{error:'Method not allowed'});
 }catch(e){json(res,400,{error:e instanceof Error?e.message:'Shared vault request failed'});}
 return true;
}
