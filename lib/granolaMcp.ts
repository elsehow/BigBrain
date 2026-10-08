/** Granola's upstream MCP client. Credentials are private, per vault/account.
 * OAuth uses the SDK's discovery, dynamic registration and PKCE implementation;
 * the browser flow and the refresh lock are lib/oauthSignIn.ts's. */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens, OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { cancelSignIn, readSignIn, saveSignIn, signInStatus, startLoopbackSignIn, withSignInLock } from './oauthSignIn';

export const GRANOLA_MCP_URL = 'https://mcp.granola.ai/mcp';
export const GRANOLA_READ_TOOLS = new Set(['get_account_info','list_meetings','get_meetings','get_meeting_transcript','list_meeting_folders','query_granola_meetings']);
interface Credential {
  generation:string; connected:boolean; redirect:string; client?:OAuthClientInformationMixed;
  tokens?:OAuthTokens; tools?:Tool[]; identity?:unknown;
}
function path(root:string,account:string){return join(root,'.spool','source-mcp','granola',createHash('sha256').update(account).digest('hex')+'.json');}
function read(root:string,account:string):Credential|undefined {return readSignIn<Credential>(path(root,account));}
function save(root:string,account:string,value:Credential){saveSignIn(path(root,account),value);}
export function granolaConnection(root:string,account:string){const c=read(root,account);return c?.connected&&c.tokens ? {generation:c.generation,identity:c.identity,tools:(c.tools??[]).filter(t=>GRANOLA_READ_TOOLS.has(t.name))}:undefined;}
export function disconnectGranola(root:string,account:string){cancelSignIn('granola',root,account);save(root,account,{generation:crypto.randomUUID(),connected:false,redirect:''});}

function provider(root:string,account:string,credential:Credential,interactive?:{state:string;redirect:(url:URL)=>void}):OAuthClientProvider {
  let verifier='';
  const valid=()=>{if(read(root,account)?.generation!==credential.generation)throw Error('Granola connection changed. Connect again.');};
  const persist=()=>{valid();save(root,account,credential);};
  return {
    redirectUrl:credential.redirect,
    clientMetadata:{client_name:'BigBrain',redirect_uris:[credential.redirect],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'},
    state:()=>interactive?.state??'',
    clientInformation:()=>credential.client,
    saveClientInformation:v=>{credential.client=v;persist();},
    tokens:()=>{valid();return credential.tokens;},
    saveTokens:v=>{credential.tokens=v;persist();},
    redirectToAuthorization:url=>{if(!interactive)throw Error('Reconnect Granola in Settings → Integrations.');interactive.redirect(url);},
    saveCodeVerifier:v=>{verifier=v;},codeVerifier:()=>verifier,
    invalidateCredentials:scope=>{if(scope==='all'||scope==='tokens')delete credential.tokens;if(scope==='all'||scope==='client')delete credential.client;persist();},
  };
}
const boundedFetch:FetchLike=(input,init)=>fetch(input,{...init,signal:AbortSignal.any([AbortSignal.timeout(30_000),...(init?.signal?[init.signal]:[])])});
function connection(auth:OAuthClientProvider,endpoint=GRANOLA_MCP_URL,fetcher:FetchLike=boundedFetch){
  const client=new Client({name:'bigbrain',version:'1.0.0'});
  const transport=new StreamableHTTPClientTransport(new URL(endpoint),{authProvider:auth,fetch:fetcher});
  return {client,transport};
}
async function catalog(client:Client){const tools:Tool[]=[];let cursor:string|undefined;for(let i=0;i<10;i++){const page=await client.listTools({cursor});tools.push(...page.tools);cursor=page.nextCursor;if(!cursor)return tools;}throw Error('Granola tool list did not finish.');}
export function mcpText(result:CallToolResult):string {return result.content.flatMap(c=>c.type==='text'?[c.text]:[]).join('\n');}
export function mcpData(result:CallToolResult):unknown {if(result.isError)throw Error('Granola could not complete the request.');if(result.structuredContent)return result.structuredContent;const text=mcpText(result);try{return JSON.parse(text);}catch{return text;}}
export function granolaSignInStatus(root:string,account:string){return signInStatus('granola',root,account);}
export function cancelGranolaSignIn(root:string,account:string){cancelSignIn('granola',root,account);}
/** Starts a loopback callback, returning a URL for the UI to open in the system browser. */
export async function startGranolaSignIn(root:string,account:string,onConnected:()=>void,options:{endpoint?:string;fetch?:FetchLike}={}) {
  const credential:Credential={generation:crypto.randomUUID(),connected:false,redirect:''};
  let conn:ReturnType<typeof connection>, closeClient:(()=>Promise<void>)|undefined;
  return startLoopbackSignIn('granola',root,account,onConnected,{
    name:'Granola',
    begin:async(redirect,state)=>{
      credential.redirect=redirect;save(root,account,credential);
      let url:URL|undefined;
      const auth=provider(root,account,credential,{state,redirect:u=>{url=u;}});
      conn=connection(auth,options.endpoint,options.fetch);closeClient=()=>conn.client.close();
      try{await conn.client.connect(conn.transport);}catch(e){if(!url)throw e;}
      if(!url)throw Error('Granola did not start browser sign-in.');
      return url;
    },
    finish:async code=>{
      await conn.transport.finishAuth(code);
      await conn.client.close();
      const next=connection(provider(root,account,credential),options.endpoint,options.fetch);closeClient=()=>next.client.close();
      await next.client.connect(next.transport);
      credential.tools=await catalog(next.client);
      if(!credential.tools.some(t=>t.name==='get_account_info'))throw Error('Granola did not offer account verification.');
      credential.identity=mcpData(await next.client.callTool({name:'get_account_info',arguments:{}}) as CallToolResult);
      if(read(root,account)?.generation!==credential.generation)throw Error('Granola connection changed.');
      credential.connected=true;save(root,account,credential);
    },
    abandon:()=>{if(read(root,account)?.generation===credential.generation)save(root,account,{generation:crypto.randomUUID(),connected:false,redirect:''});},
    close:async()=>{await closeClient?.();},
  });
}
/** Serialize refreshes across the web process and integration poller. */
export async function withGranola<T>(root:string,account:string,fn:(client:Client,tools:Tool[])=>Promise<T>,options:{endpoint?:string;fetch?:FetchLike;signal?:AbortSignal}={}):Promise<T>{
  return withSignInLock(path(root,account).replace(/\.json$/,'.lock.sqlite'),async()=>{
    let conn:ReturnType<typeof connection>|undefined;
    try{
      const c=read(root,account);if(!c?.connected||!c.tokens)throw Error('Connect Granola in Settings → Integrations.');
      options.signal?.throwIfAborted();conn=connection(provider(root,account,c),options.endpoint,options.fetch);
      const close=()=>{void conn?.client.close();};options.signal?.addEventListener('abort',close,{once:true});
      try{await conn.client.connect(conn.transport);const tools=await catalog(conn.client);
        const identity=mcpData(await conn.client.callTool({name:'get_account_info',arguments:{}},undefined,{signal:options.signal}) as CallToolResult);
        if(JSON.stringify(identity)!==JSON.stringify(c.identity))throw Error('Granola account or active workspace changed. Reconnect it in Settings → Integrations.');
        const result=await fn(conn.client,tools);options.signal?.throwIfAborted();if(!granolaConnection(root,account)||read(root,account)?.generation!==c.generation)throw Error('Granola connection changed.');return result;}
      finally{options.signal?.removeEventListener('abort',close);}
    }finally{await conn?.client.close().catch(()=>{});}
  },{busy:'Granola is busy. Try again.',signal:options.signal});
}
