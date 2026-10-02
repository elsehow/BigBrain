/** Local owner UI. A launch secret establishes an HttpOnly browser session;
 * member credentials never reach browser storage. The normal shared API still
 * verifies the member on every request. Not a remotely exposed admin service. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeAtomic } from './fsx';
import { acquire, release } from './pidLock';
import { initMemberStore, verifyCredential } from './sharedMembers';
import { SharedVault } from './sharedVault';
import { makeSharedApiHandler } from './sharedVaultApi';

interface OwnerConnection { name: string; token: string }
const random = () => randomBytes(32).toString('base64url');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function sharedOwner(home: string, assets: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const root = join(home, 'vault'), store = join(home, 'members.json'), connectionPath = join(home, 'owner.json');
  const lock = join(home, 'owner-ui.lock');
  if (!acquire(lock)) throw new Error('An owner interface is already running for this directory.');
  let vaultLock = false;
  let connection: OwnerConnection | null = null;
  let api: ReturnType<typeof makeSharedApiHandler> | null = null;
  const close = () => { if (vaultLock) release(join(root, '.state/shared-server.lock')); release(lock); };
  function attach() {
    if (!connection) return;
    if (!/^shared:\s*true\s*$/m.test(readFileSync(join(root, 'vault.yaml'), 'utf8'))) throw new Error('This is not an initialized shared vault.');
    const who = verifyCredential(store, connection.token);
    if (!who.ok || who.actor.role !== 'owner') throw new Error('Saved owner connection is no longer authorized.');
    mkdirSync(join(root, '.state'), { recursive: true });
    if (!acquire(join(root, '.state/shared-server.lock'))) throw new Error('The shared vault is already being served. Stop that server first.');
    vaultLock = true;
    const vault = new SharedVault(root);
    vault.recoverPending();
    api = makeSharedApiHandler({ root, storePath: store, vault, log: () => {} });
  }
  let session: string;
  try {
    const keyPath = join(home, 'browser-session');
    if (!existsSync(keyPath)) writeAtomic(keyPath, random(), 0o600);
    session = readFileSync(keyPath, 'utf8');
    if (existsSync(connectionPath)) { connection = JSON.parse(readFileSync(connectionPath, 'utf8')); attach(); }
  } catch (e) { close(); throw e; }
  let launchSecret = random();
  const cookie = 'bb_shared_' + Buffer.from(home).toString('base64url').slice(-24);
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
  const json = (status: number, body: unknown) => Response.json(body, { status, headers });
  const token = () => launchSecret;
  const fetch = async (req: Request) => {
    const url = new URL(req.url);
    if (url.hostname !== '127.0.0.1' || req.headers.get('host') !== url.host) return json(403, { error: 'Local access only.' });
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return json(403, { error: 'Foreign origin refused.' });
    if (req.headers.get('sec-fetch-site') === 'cross-site') return json(403, { error: 'Foreign site refused.' });
    if (req.method === 'GET' && ['/', '/owner.js', '/owner.css', '/hanken.woff2'].includes(url.pathname)) {
      const file = join(assets, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (!existsSync(file)) return json(404, { error: 'Asset missing.' });
      return new Response(readFileSync(file), { headers: { ...headers, 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.woff2') ? 'font/woff2' : 'text/html' } });
    }
    if (!['GET', 'POST'].includes(req.method)) return json(405, { error: 'Method not allowed.' });
    if (req.method === 'POST' && (origin !== url.origin || req.headers.get('content-type')?.split(';')[0] !== 'application/json')) return json(403, { error: 'Same-origin JSON request required.' });
    try {
      if (url.pathname === '/session' && req.method === 'POST') {
        const body = await req.json() as { secret?: unknown };
        if (!launchSecret || typeof body.secret !== 'string' || !equal(body.secret, launchSecret)) return json(401, { error: 'Open the owner interface from its launcher again.' });
        launchSecret = '';
        return new Response('{}', { headers: { ...headers, 'Content-Type': 'application/json', 'Set-Cookie': `${cookie}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` } });
      }
      const saved = (req.headers.get('cookie') ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(cookie + '='))?.slice(cookie.length + 1) ?? '';
      if (!equal(saved, session)) return json(401, { error: 'Open the owner interface from its launcher to connect.' });
      if (url.pathname === '/owner' && req.method === 'GET') {
        if (connection) {
          const who = verifyCredential(store, connection.token);
          if (!who.ok || who.actor.role !== 'owner') return json(401, { error: 'Owner connection revoked.' });
          return json(200, { name: connection.name, handle: who.actor.handle, role: who.actor.role, path: root });
        }
        return json(200, { setup: true, path: root });
      }
      if (url.pathname === '/owner' && req.method === 'POST') {
        if (connection || existsSync(store) || (existsSync(root) && readdirSync(root).length)) return json(409, { error: 'This directory already contains a vault. Use a new empty home directory.' });
        const body = await req.json() as { name?: unknown; handle?: unknown };
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || typeof body.handle !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(body.handle)) return json(400, { error: 'Enter a vault name and an owner handle (lowercase letters, numbers, dots or hyphens).' });
        // No user-controlled filesystem paths, and no implicit personal-vault discovery.
        const created = initMemberStore(store, root, { handle: body.handle });
        mkdirSync(root, { recursive: true, mode: 0o700 });
        writeFileSync(join(root, 'vault.yaml'), 'shared: true\n', { mode: 0o600 });
        connection = { name: body.name.trim(), token: created.token };
        writeAtomic(connectionPath, JSON.stringify(connection), 0o600);
        attach();
        return json(201, { name: connection.name, handle: body.handle, role: 'owner', path: root });
      }
      if (url.pathname.startsWith('/v1/') && api && connection) {
        // The browser cannot choose another identity; the backend holds this credential.
        const forwarded = new Headers(req.headers);
        forwarded.set('authorization', `Bearer ${connection.token}`);
        const response = await api(new Request(req.url, { method: req.method, headers: forwarded, ...(req.method === 'POST' ? { body: await req.text() } : {}) }));
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        return response;
      }
      return json(404, { error: 'Not found.' });
    } catch { return json(500, { error: 'Could not complete the operation. Your saved files have been retained.' }); }
  };
  return { fetch, close, token };
}
