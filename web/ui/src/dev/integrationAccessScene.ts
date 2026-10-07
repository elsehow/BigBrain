/** Production settings components, fabricated accounts/clients, no provider calls. */
import { api } from '../lib/api';
import type { IntegrationInfo } from '../lib/types';
export function installIntegrationAccessScene(fail=false) {
  const original=api.config;
  const fixture:IntegrationInfo={name:'email',enabled:false,hasCode:true,hasTrigger:true,env:[],activation:{accounts:['me@example.com','work@example.com'],callers:[],grants:[]}};
  api.config=async()=>({...await original(),integrations:[structuredClone(fixture),{...structuredClone(fixture),name:"that-tracks"}]});
  const accounts=['me@example.com','work@example.com'].map(account=>({name:'email',account,label:account,connected:false,checkedAt:null as string|null,grants:[] as {caller:string;access:string}[],capabilities:{read:'Read current messages and flags without remembering.',write:'Mark messages read or unread.'}}));
  const clients:{id:string;name:string;kind:string;revoked:string|null;lastUsed:string|null;legacy:boolean;replaces?:string;managedBy?:string;expired?:boolean;expiredUse?:string|null}[]=[{id:'12345678',name:'Codex on sample laptop',kind:'codex',revoked:null,lastUsed:"2026-09-24T00:00:00Z",legacy:false,replaces:undefined,managedBy:undefined}];
  if(new URLSearchParams(location.search).has('managed-clients'))clients.push({id:'runner-codex',name:'Orchestration: Codex',kind:'codex',managedBy:'runner:codex',revoked:null,lastUsed:null,legacy:false,replaces:undefined},{id:'runner-claude',name:'Orchestration: Claude Code',kind:'claude-code',managedBy:'runner:claude-code',revoked:null,lastUsed:'2026-09-24T00:00:00Z',legacy:false,replaces:undefined});
  if(new URLSearchParams(location.search).has('legacy-clients'))clients.push({id:'11111111',name:'Claude Code plugin',kind:'claude-code',managedBy:'claude-plugin',revoked:null,lastUsed:'2026-09-24T00:00:00Z',legacy:true,replaces:undefined});
  if(new URLSearchParams(location.search).has('revoked-legacy-clients'))clients.push({id:'33333333',name:'Retired Codex plugin',kind:'codex',managedBy:'codex-plugin',revoked:'2026-09-25T00:00:00Z',lastUsed:'2026-09-24T00:00:00Z',legacy:true,replaces:undefined});
  // `?expired-clients`: lapsed connections a client just tried (one notice for both, one of them the
  // legacy `bigbrain connect` credential), and one nobody tried (quiet); `=one` tries only the first,
  // `=many` three more
  const expiredClients=new URLSearchParams(location.search).get('expired-clients');
  if(expiredClients!==null)clients.push(
    {id:'77777777',name:'Claude Code at the studio',kind:'claude-code',managedBy:undefined,revoked:null,lastUsed:'2026-08-01T00:00:00Z',legacy:false,replaces:undefined,expired:true,expiredUse:'2026-10-06T09:30:00Z'},
    {id:'99999999',name:'claude code on sample laptop',kind:'claude-code',managedBy:undefined,revoked:null,lastUsed:'2026-08-15T00:00:00Z',legacy:true,replaces:undefined,expired:true,expiredUse:'2026-10-06T10:00:00Z'},
    {id:'88888888',name:'Old generic client',kind:'generic',managedBy:undefined,revoked:null,lastUsed:'2026-07-01T00:00:00Z',legacy:false,replaces:undefined,expired:true,expiredUse:null},
  );
  if(expiredClients==='one')clients.find(c=>c.id==='99999999')!.expiredUse=null;
  if(expiredClients==='many')for(const [id,name] of [['a1a1a1a1','Codex in the workshop'],['b2b2b2b2','Generic client on a sample server'],['c3c3c3c3','Claude Code on a borrowed laptop']])
    clients.push({id,name,kind:'generic',managedBy:undefined,revoked:null,lastUsed:'2026-08-20T00:00:00Z',legacy:false,replaces:undefined,expired:true,expiredUse:'2026-10-06T11:00:00Z'});
  if(new URLSearchParams(location.search).has('same-name-clients'))clients.push(
    {id:'44444444',name:'Claude Code',kind:'claude-code',managedBy:undefined,revoked:null,lastUsed:'2026-09-20T00:00:00Z',legacy:false,replaces:undefined},
    {id:'55555555',name:'Claude Code',kind:'claude-code',managedBy:undefined,revoked:null,lastUsed:'2026-09-24T00:00:00Z',legacy:false,replaces:'66666666'},
  );
  window.addEventListener('workbench-client-connected',event=>{
    const client=clients.find(c=>c.id===(event as CustomEvent<string>).detail)!;
    client.lastUsed=new Date().toISOString();
    if(client.replaces)clients.find(c=>c.id===client.replaces)!.revoked=new Date().toISOString();
  });
  const state=()=>({accounts,callers:[{id:'pilot',label:'Pilot'},...clients.filter(c=>!c.revoked).map(c=>({id:'token:'+c.id,label:c.name}))]});
  const prior=window.fetch.bind(window);
  window.fetch=(async(input: RequestInfo | URL,options?: RequestInit)=>{
    const path=new URL(input instanceof Request?input.url:String(input),location.href).pathname;
    const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
    if(!['/api/integration-accounts','/api/connected-clients'].includes(path))return prior(input,options);
    const body=JSON.parse(typeof options?.body==='string'?options.body:'{}');
    if(path==='/api/connected-clients'){
      if(!options?.method)return json({clients});
      if(body.action==='revoke'){clients.find(c=>c.id===body.id)!.revoked=new Date().toISOString();return json({ok:true});}
      if(body.action==='renew'){Object.assign(clients.find(c=>c.id===body.id)!,{expired:false,expiredUse:null});return json({ok:true});}
      if(body.action==='dismiss'){clients.find(c=>c.id===body.id)!.expiredUse=null;return json({ok:true});}
      if(body.action==='reconnect')clients.find(c=>c.id===body.id)!.revoked=null;
      let id=body.id;
      if(body.action==='replace'){id='22222222';if(!clients.some(c=>c.id===id))clients.push({id,name:'Replacement Claude',kind:'claude-code',revoked:null,lastUsed:null,legacy:false,replaces:body.id,managedBy:undefined});}
      if(body.action==='create'){id='87654321';clients.push({id,name:body.name,kind:body.kind,revoked:null,lastUsed:null,legacy:false,replaces:undefined,managedBy:undefined});}
      return json({id,command:`claude mcp add bigbrain -- bigbrain mcp --client ${id}`,configuration:{},instructions:'Run this command in your client, then restart its MCP connection.'});
    }
    if(!options?.method)return json(state());
    window.dispatchEvent(new CustomEvent('workbench-integration-action',{detail:body}));
    const account=accounts.find(a=>a.account===body.account)!;
    if(body.action==='connect'){
      if(fail){fail=false;return json({error:'Account access failed. Check the inbox connection.'},400);}account.connected=true;
      // a first connection starts at the default: Pilot reads, clients off
      if(!account.checkedAt){account.checkedAt=new Date().toISOString();account.grants=[{caller:'pilot',access:'read'}];}
    }else if(body.action==='disconnect')account.connected=false;
    else if(body.action==='save'||body.action==='grant'){
      // only the callers named change, as on the server
      for(const g of body.action==='grant'?[{caller:body.caller,access:body.access}]:body.grants??[])account.grants=[...account.grants.filter(x=>x.caller!==g.caller),...(g.access==='off'?[]:[g])];
    }
    return json(state());
  }) as typeof window.fetch;
}
