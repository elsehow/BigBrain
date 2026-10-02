/** Local connection credentials, outside every vault. Never return secrets to the UI. */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeAtomic } from './fsx';
import { sharedConnectionsStore } from './env';
export interface SharedConnection { id: string; name: string; endpoint: string; token: string; memberId?: string;
  /** The member's agent delegate, minted on first publish (lib/sharedAssertionPublish.ts). */
  agentToken?: string }
export interface SharedIdentity { vault?: {id:string;name:string}; handle: string; display: string; role: string; permissions: string[]; member_id: string; credential: { id: string; name: string } }
export class SharedConnectionError extends Error { constructor(public status: number, message: string) { super(message); } }
export function connectionStorePath(): string { return sharedConnectionsStore() ?? join(homedir(), '.config/bigbrain/shared-connections.json'); }
export function readConnections(path: string): SharedConnection[] { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []; }
const writeConnections = (path: string, connections: SharedConnection[]) => writeAtomic(path, JSON.stringify(connections, null, 2) + '\n', 0o600);
export function publicConnection({ id, name, endpoint }: SharedConnection) { return { id, name, endpoint }; }
export function endpointURL(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new SharedConnectionError(400, 'Enter a valid server address.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new SharedConnectionError(400, 'Use an HTTPS server address, or HTTP on localhost.');
  return url.origin;
}
export async function sharedRequest<T>(connection: SharedConnection, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(connection.endpoint + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) }); }
  catch { throw new SharedConnectionError(503, 'The shared vault is unavailable.'); }
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new SharedConnectionError(response.status, typeof data.error === 'string' ? data.error.replaceAll(connection.token, '[redacted]').slice(0, 500) : 'The shared vault refused this request.');
  }
  return await response.json() as T;
}
/** A vault's join link (`/join`) — or any door page without an invite secret —
 * opens in a browser, where the member signs in and creates an app link. */
const JOIN_LINK_PATHS=new Set(['/','/join','/join/','/me','/invite']);
export async function connectInvite(path:string,link:unknown) {
  if(typeof link!=='string')throw new SharedConnectionError(400,'Paste an invite link.');
  let url:URL;try{url=new URL(link)}catch{throw new SharedConnectionError(400,'Invalid invite link.');}
  // Refused before anything touches the network.
  if(JOIN_LINK_PATHS.has(url.pathname)&&!url.hash)throw new SharedConnectionError(400,'That is the vault’s join link — open it in your browser, sign in, choose “Create an app link” under Connect the BigBrain app, and paste that link here.');
  const endpoint=endpointURL(url.origin);
  if(url.username||url.password||url.search||url.pathname!=='/invite'||!/^#[A-Za-z0-9_-]{43}$/.test(url.hash))throw new SharedConnectionError(400,'Invalid invite link.');
  const response=await fetch(endpoint+'/v1/invites/redeem',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${url.hash.slice(1)}`},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new SharedConnectionError(response.status,'Invitation is expired, already used, or unavailable. Request a new one.');
  const result=await response.json() as {token:string;vault:{id:string;name:string}};
  return saveConnection(path,{name:result.vault.name,endpoint,token:result.token});
}
export async function saveConnection(path: string, input: { name?: unknown; endpoint?: unknown; token?: unknown }) {
  if (typeof input.name !== 'string' || !input.name.trim() || typeof input.endpoint !== 'string' || typeof input.token !== 'string' || !/^sv_[A-Za-z0-9_-]+$/.test(input.token))
    throw new SharedConnectionError(400, 'Enter a name, server address, and member credential.');
  const connection: SharedConnection = { id: randomUUID(), name: input.name.trim().slice(0, 100), endpoint: endpointURL(input.endpoint), token: input.token };
  const identity = await sharedRequest<SharedIdentity>(connection, '/v1/whoami');
  if (!identity.permissions.includes('read')) throw new SharedConnectionError(403, 'This credential cannot read the vault.');
  const connections = readConnections(path);
  if(identity.vault)connection.name=identity.vault.name;
  connection.memberId=identity.member_id;
  const existing=connections.find(c=>c.endpoint===connection.endpoint&&c.memberId===identity.member_id);
  if(existing){connection.id=existing.id;connections.splice(connections.indexOf(existing),1);}
  connections.push(connection);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeConnections(path, connections);
  return { ...publicConnection(connection), identity };
}

export function updateConnection(path:string,id:string,patch:Partial<Omit<SharedConnection,'id'>>) {
 const connections=readConnections(path),connection=connections.find(c=>c.id===id);
 if(!connection)return;
 Object.assign(connection,patch);writeConnections(path,connections);
}

export async function refreshConnectionNames(path:string) {
 const connections=readConnections(path),names=new Map<string,string>();
 await Promise.all(connections.map(async c=>{try{const who=await sharedRequest<SharedIdentity>(c,'/v1/whoami');if(who.vault?.name)names.set(c.id,who.vault.name);}catch{/* Offline connections keep their last verified name. */}}));
 const latest=readConnections(path);let changed=false;
 for(const c of latest){const name=names.get(c.id);if(name&&name!==c.name){c.name=name;changed=true;}}
 if(changed)writeConnections(path,latest);
 return latest.map(publicConnection);
}
