/** Local connection credentials, outside every vault. Never return secrets to the UI. */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeAtomic } from './fsx';
import { sharedConnectionsStore } from './env';
export interface SharedConnection { id: string; name: string; endpoint: string; token: string }
export interface SharedIdentity { handle: string; display: string; role: string; permissions: string[]; member_id: string; credential: { id: string; name: string } }
export class SharedConnectionError extends Error { constructor(public status: number, message: string) { super(message); } }
export function connectionStorePath(): string { return sharedConnectionsStore() ?? join(homedir(), '.config/bigbrain/shared-connections.json'); }
export function readConnections(path: string): SharedConnection[] { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []; }
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
export async function saveConnection(path: string, input: { name?: unknown; endpoint?: unknown; token?: unknown }) {
  if (typeof input.name !== 'string' || !input.name.trim() || typeof input.endpoint !== 'string' || typeof input.token !== 'string' || !/^sv_[A-Za-z0-9_-]+$/.test(input.token))
    throw new SharedConnectionError(400, 'Enter a name, server address, and member credential.');
  const connection = { id: randomUUID(), name: input.name.trim().slice(0, 100), endpoint: endpointURL(input.endpoint), token: input.token };
  const identity = await sharedRequest<SharedIdentity>(connection, '/v1/whoami');
  if (!identity.permissions.includes('read')) throw new SharedConnectionError(403, 'This credential cannot read the vault.');
  const connections = readConnections(path);
  connections.push(connection);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeAtomic(path, JSON.stringify(connections, null, 2) + '\n', 0o600);
  return { ...publicConnection(connection), identity };
}
