/** What get_account_info answers, in Granola's shape (invented values). */
export const fixtureAccountInfo=(email='fixture@example.test',workspace='fixture-workspace'):Record<string,unknown>=>({email,mcp_plan:'plus',active_workspace:{id:workspace,display_name:'Fixture'},workspaces:[{id:workspace,display_name:'Fixture'}]});
/** A local stand-in for Granola's MCP server: OAuth discovery, dynamic
 * registration, tokens and the tools endpoint. `tools` is what it lists
 * beside get_account_info; `onCall` answers a call to any of them;
 * `setAccountInfo` changes what get_account_info answers for an email. */
export function fakeGranola(onCall?:(name:string,args:any)=>unknown|Promise<unknown>,onToken?:()=>Promise<void>,tools:Record<string,unknown>[]=['list_meetings','get_meetings','get_meeting_transcript'].map(name=>({name,inputSchema:{type:'object'}}))){
 let base='',registrations=0,calls:string[]=[],info=(email:string)=>fixtureAccountInfo(email);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const u=new URL(req.url),json=(v:unknown,status=200,headers={})=>Response.json(v,{status,headers});
  if(u.pathname==='/resource')return json({resource:base+'/mcp',authorization_servers:[base]});
  if(u.pathname.includes('oauth-authorization-server')||u.pathname.includes('openid-configuration'))return json({issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',registration_endpoint:base+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
  if(u.pathname==='/register'){registrations++;return json({...await req.json() as object,client_id:'fixture-client-'+registrations},201);}
  if(u.pathname==='/token'){await onToken?.();const f=await req.formData();return json({access_token:'fixture-'+String(f.get('code')??'refresh'),refresh_token:'fixture-refresh',token_type:'Bearer',expires_in:3600});}
  if(u.pathname==='/mcp'){
   const token=req.headers.get('authorization');if(!token)return json({error:'unauthorized'},401,{'www-authenticate':`Bearer resource_metadata="${base}/resource"`});
   if(req.method==='GET')return new Response(null,{status:405});
   if(req.method==='DELETE')return new Response(null,{status:200});
   const message=await req.json() as any;if(message.id===undefined)return new Response(null,{status:202});
   let result:unknown={};
   if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
   if(message.method==='tools/list')result={tools:[{name:'get_account_info',inputSchema:{type:'object'}},...tools]};
   if(message.method==='tools/call'){calls.push(message.params.name);result=message.params.name!=='get_account_info'&&onCall?await onCall(message.params.name,message.params.arguments):{content:[{type:'text',text:JSON.stringify(info(token.includes('personal')?'personal@example.test':'work@example.test'))}]};}
   return json({jsonrpc:'2.0',id:message.id,result});
  }
  return new Response('missing',{status:404});
 }});base=`http://127.0.0.1:${server.port}`;
 return {server,endpoint:base+'/mcp',calls,registered:()=>registrations,setAccountInfo:(next:(email:string)=>unknown)=>{info=next as typeof info;}};
}
