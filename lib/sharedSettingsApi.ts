import {readSourceInsertionLog,insertionEventRel} from './insertionLog';
import {jevSettingsStatus} from './jevSettings';
import {sourceKey} from './sharedRules';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {json,readBody} from './httpx';
import {allowVaultRequest,vaultIdentity} from './vaultBoundary';
import {SharedConnectionError,connectionStorePath,readConnections,publicConnection,refreshConnectionNames,connectInvite,sharedRequest} from './sharedConnections';
import {serializeMentions,type MentionPart} from './pilotMentions';
import {searchRuleEntities} from './sharedRuleMentions';
import {contributions} from './sharedRules';
import {listLenses,updateLens} from './lenses';
import {lensNotes} from './lensScoring';
import {originOf} from './lensSync';
import {tickPublishing} from './sharedAssertionPublish';
import {pages} from './sharedReadUnion';
import type {SourceInsertion} from './insertionLog';
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
  // A server note opens as your own when it came from your vault.
  const local=()=>new Map(readSourceInsertionLog(root,{strict:true}).map(s=>['origin:'+sourceKey(s),insertionEventRel(s)]));
  if(req.method==='GET'&&action==='vault'){
   const mine=local(),notes=new Map(lensNotes(root).map(n=>[originOf(n.source_id),n.source_id])),lenses=listLenses(root,store).filter(l=>l.servers.includes(c.id));
   const items=(await contributions(c)).map(item=>{const sid=notes.get(item.source_id);return {...item,path:mine.get(item.source_id)??`shared/${c.id}/${item.insertion_id}.md`,lenses:sid?lenses.filter(l=>l.members.includes(sid)).map(l=>l.name):[]};});
   json(res,200,{...publicConnection(c),identity:await sharedRequest(c,'/v1/whoami'),evaluator:jevSettingsStatus(store).evaluator,items});
  }
  else if(req.method==='GET'&&action==='notes'){
   const mine=local();
   const notes=(await pages<SourceInsertion&{submitted_at?:string}>(c,'evidence')).map(e=>({id:e.id,title:e.title,by:typeof e.envelope.submitted_by==='string'?e.envelope.submitted_by:null,at:e.submitted_at??e.received_at??'',path:mine.get(e.source_id)??`shared/${c.id}/${e.id}.md`}));
   json(res,200,{notes:notes.sort((a,b)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id))});
  }
  else if(req.method==='GET'&&action==='search'){
   const {hits}=await sharedRequest<{hits:{kind:string;id:string}[]}>(c,`/v1/search?limit=50&q=${encodeURIComponent(url.searchParams.get('q')??'')}`);
   json(res,200,{ids:hits.filter(h=>h.kind==='evidence').map(h=>h.id)});
  }
  else if(req.method==='GET'&&action==='members'){json(res,200,await sharedRequest(c,'/v1/members'));}
  else if(req.method==='POST') {
   const body=JSON.parse(await readBody(req,100000));
   if(action==='member-invite')json(res,201,await sharedRequest(c,'/v1/invites',{name:body.name,permission:body.permission}));
   else if(action==='member-add')json(res,201,await sharedRequest(c,'/v1/members',{email:body.email,permission:body.permission}));
   else if(['member-access','member-remove','invite-cancel'].includes(action??'')) {
    if(typeof body.id!=='string'||! /^(mem_[a-f0-9]{8}|[a-f0-9]{24})$/.test(body.id))throw Error('Invalid member or invitation.');
    const path=action==='invite-cancel'?`/v1/invites/${body.id}/cancel`:`/v1/members/${body.id}/${action==='member-access'?'access':'remove'}`;
    json(res,200,await sharedRequest(c,path,{permission:body.permission}));
   }
   else if(action==='recommendation') {
    const who=await sharedRequest<{vault:{recommended_rules?:{id:string;text:string;mentions:string[]}[]}}>(c,'/v1/whoami');
    const recommendation=who.vault.recommended_rules?.find(r=>r.id===body.id);if(!recommendation)throw Error('Suggested rule unavailable');
    let text=recommendation.text;
    for(const label of recommendation.mentions){const hits=searchRuleEntities(root,label).filter(e=>e.title.toLowerCase()===label.toLowerCase());if(hits.length!==1)throw Error(`Select @${label} from your vault before using this suggestion.`);text=text.replaceAll('@'+label,serializeMentions([{mention:hits[0]!}] as MentionPart[]));}
    json(res,200,{text});
   }
   else if(action==='withdraw') {
    if(typeof body.id!=='string'||!/^sc_[a-f0-9]{24}$/.test(body.id))throw Error('Invalid contribution');
    // Withdrawn here means removed from every lens that shares it with this server, or the next tick puts it back.
    const x=(await contributions(c)).find(x=>x.id===body.id),note=x&&lensNotes(root).find(n=>originOf(n.source_id)===x.source_id);
    if(note)for(const lens of listLenses(root,store))if(lens.servers.includes(c.id)&&lens.members.includes(note.source_id))updateLens(root,store,lens.id,l=>{l.exclusions=[...new Set([...l.exclusions,note.source_id])];l.pins=l.pins.filter(p=>p!==note.source_id);l.members=l.members.filter(m=>m!==note.source_id);});
    json(res,200,await sharedRequest(c,`/v1/contributions/${body.id}/withdraw`,{request_id:body.request_id,version:body.version}));
    void tickPublishing(root,store,c.id); // retract claims that cited a withdrawn source now, not on the next tick
   }else json(res,404,{error:'Not found'});
  }else json(res,405,{error:'Method not allowed'});
 }catch(e){json(res,e instanceof SharedConnectionError?e.status:400,{error:e instanceof Error?e.message:'Server request failed'});}
 return true;
}
