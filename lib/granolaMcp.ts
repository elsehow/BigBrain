/** Granola's upstream MCP client. Credentials are private, per vault/account.
 * OAuth uses the SDK's discovery, dynamic registration and PKCE implementation. */
import { createServer, type Server } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens, OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { writeAtomic } from './fsx';
import { acquire, release } from './pidLock';

export const GRANOLA_MCP_URL = 'https://mcp.granola.ai/mcp';
export const GRANOLA_READ_TOOLS = new Set(['get_account_info','list_meetings','get_meetings','get_meeting_transcript','list_meeting_folders','query_granola_meetings']);
interface Credential {
  generation:string; connected:boolean; redirect:string; client?:OAuthClientInformationMixed;
  tokens?:OAuthTokens; tools?:Tool[]; identity?:unknown;
}
function path(root:string,account:string){return join(root,'.spool','source-mcp','granola',createHash('sha256').update(account).digest('hex')+'.json');}
function read(root:string,account:string):Credential|undefined {try{return JSON.parse(readFileSync(path(root,account),'utf8'));}catch{return undefined;}}
function save(root:string,account:string,value:Credential){mkdirSync(dirname(path(root,account)),{recursive:true,mode:0o700});writeAtomic(path(root,account),JSON.stringify(value)+'\n',0o600);}
export function granolaConnection(root:string,account:string){const c=read(root,account);return c?.connected&&c.tokens ? {generation:c.generation,identity:c.identity,tools:(c.tools??[]).filter(t=>GRANOLA_READ_TOOLS.has(t.name))}:undefined;}
export function disconnectGranola(root:string,account:string){flows.get(root+'\n'+account)?.cancel();save(root,account,{generation:crypto.randomUUID(),connected:false,redirect:''});}

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
interface Flow {url?:string;phase:'starting'|'browser'|'connected'|'error'|'cancelled';error?:string;cancel:()=>void}
const flows=new Map<string,Flow>();
export function granolaSignInStatus(root:string,account:string){const f=flows.get(root+'\n'+account);return f?{phase:f.phase,url:f.url,error:f.error}:undefined;}
export function cancelGranolaSignIn(root:string,account:string){flows.get(root+'\n'+account)?.cancel();}
/** Starts a loopback callback, returning a URL for the UI to open in the system browser. */
export async function startGranolaSignIn(root:string,account:string,onConnected:()=>void,options:{endpoint?:string;fetch?:FetchLike}={}) {
  const key=root+'\n'+account;flows.get(key)?.cancel();
  const state=crypto.randomUUID(),credential:Credential={generation:crypto.randomUUID(),connected:false,redirect:''};
  let server:Server, timer:ReturnType<typeof setTimeout>|undefined, active=true;
  let closeClient:(()=>Promise<void>)|undefined;
  const cleanup=()=>{if(timer)clearTimeout(timer);server?.close();void closeClient?.().catch(()=>{});};
  const flow:Flow={phase:'starting',cancel:()=>{if(['connected','cancelled','error'].includes(flow.phase))return;active=false;flow.phase='cancelled';delete flow.url;cleanup();if(read(root,account)?.generation===credential.generation)save(root,account,{generation:crypto.randomUUID(),connected:false,redirect:''});}};
  flows.set(key,flow);
  let conn:ReturnType<typeof connection>;
  server=createServer(async(req,res)=>{
    const url=new URL(req.url??'/',credential.redirect);
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/plain; charset=utf-8');
    if(req.method!=='GET'||url.pathname!=='/callback'||url.searchParams.get('state')!==state||!active){res.writeHead(400);res.end('Invalid or expired sign-in.');return;}
    active=false;delete flow.url;
    try {
      const code=url.searchParams.get('code');if(!code||url.searchParams.has('error'))throw Error('Granola sign-in was cancelled.');
      await conn.transport.finishAuth(code);
      await conn.client.close();
      const next=connection(provider(root,account,credential),options.endpoint,options.fetch);closeClient=()=>next.client.close();
      await next.client.connect(next.transport);
      credential.tools=await catalog(next.client);
      if(!credential.tools.some(t=>t.name==='get_account_info'))throw Error('Granola did not offer account verification.');
      credential.identity=mcpData(await next.client.callTool({name:'get_account_info',arguments:{}}) as CallToolResult);
      if(read(root,account)?.generation!==credential.generation)throw Error('Granola connection changed.');
      credential.connected=true;save(root,account,credential);onConnected();flow.phase='connected';res.end('Granola connected. Return to BigBrain.');
    }catch(e){flow.phase='error';flow.error=e instanceof Error?e.message:'Granola sign-in failed.';res.writeHead(400);res.end('Could not connect Granola. Return to BigBrain and try again.');}
    finally{cleanup();}
  });
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string')throw Error('Could not start sign-in.');
    credential.redirect=`http://127.0.0.1:${address.port}/callback`;save(root,account,credential);
    const auth=provider(root,account,credential,{state,redirect:url=>{flow.url=url.toString();flow.phase='browser';}});
    conn=connection(auth,options.endpoint,options.fetch);closeClient=()=>conn.client.close();
    try{await conn.client.connect(conn.transport);}catch(e){if(!flow.url)throw e;}
    if(!flow.url)throw Error('Granola did not start browser sign-in.');
    timer=setTimeout(()=>flow.cancel(),10*60_000);timer.unref?.();
    return granolaSignInStatus(root,account)!;
  }catch(e){flow.cancel();flow.phase='error';flow.error=e instanceof Error?e.message:'Could not start Granola sign-in.';throw Error(flow.error);}
}
/** Serialize refreshes across the web process and integration poller. */
export async function withGranola<T>(root:string,account:string,fn:(client:Client,tools:Tool[])=>Promise<T>,options:{endpoint?:string;fetch?:FetchLike;signal?:AbortSignal}={}):Promise<T>{
  const lock=path(root,account)+'.lock';mkdirSync(dirname(lock),{recursive:true,mode:0o700});
  const deadline=Date.now()+30_000;
  while(!acquire(lock)){options.signal?.throwIfAborted();if(Date.now()>deadline)throw Error('Granola is busy. Try again.');await new Promise(r=>setTimeout(r,50));}
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
  }finally{await conn?.client.close().catch(()=>{});release(lock);}
}
