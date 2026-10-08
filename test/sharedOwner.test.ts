import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sharedOwner } from '../lib/sharedOwner';
import { initMemberStore, revokeMember } from '../lib/sharedMembers';
import { sharedServerLock } from '../lib/sharedVault';
import { isHeld } from '../lib/sqliteLock';
import { holdElsewhere } from './support/lockElsewhere';
const assets = resolve('web/shared-owner');
test('owner setup requires a one-use launch secret, persists, and respects revocation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shared-owner-'));
  let app = sharedOwner(home, assets);
  const origin = 'http://127.0.0.1:4750';
  let cookie = '';
  const request = (path: string, body?: unknown, extra: Record<string,string> = {}) => app.fetch(new Request(origin + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { host: '127.0.0.1:4750', cookie, ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  try {
    expect((await request('/owner')).status).toBe(401);
    expect((await request('/v1/evidence')).status).toBe(401);
    expect((await request('/session', {secret: app.token()}, {origin:'https://untrusted.example'})).status).toBe(403);
    expect((await app.fetch(new Request('http://attacker.example/owner',{headers:{host:'attacker.example'}}))).status).toBe(403);
    const secret = app.token();
    const session = await request('/session', {secret});
    expect(session.status).toBe(200);
    expect(session.headers.get('set-cookie')).toContain('HttpOnly');
    cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    expect((await request('/session', {secret})).status).toBe(401);
    expect((await request('/owner')).status).toBe(200);
    const created = await request('/owner', {name:'Example team', handle:'owner'});
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.json())).not.toContain('sv_');
    expect((await request('/owner', {name:'Other team',handle:'other'})).status).toBe(409);
    expect(statSync(join(home,'owner.json')).mode & 0o777).toBe(0o600);
    const token = JSON.parse(readFileSync(join(home,'owner.json'),'utf8')).token;
    expect((await request('/owner')).headers.get('cache-control')).toBe('no-store');
    const evidence = await request('/v1/evidence',{title:'Example decision',body:'We will test the local owner interface first.'});
    expect(evidence.status).toBe(201);
    const saved = await evidence.json() as { id: string };
    expect(JSON.stringify(saved)).not.toContain(token);
    app.close(); app = sharedOwner(home, assets);
    expect((await request('/owner')).status).toBe(200); // retained browser session and owner connection
    expect((await request('/v1/evidence/'+saved.id)).status).toBe(200);
    expect(()=>sharedOwner(home,assets)).toThrow('already running');
    // Owner member can't be revoked by the store API, but its device credential can.
    const { revokeCredential, listCredentials } = await import('../lib/sharedMembers');
    expect(()=>revokeMember(join(home,'members.json'),'owner')).toThrow();
    revokeCredential(join(home,'members.json'),listCredentials(join(home,'members.json'))[0]!.id);
    expect((await request('/owner')).status).toBe(401);
    expect((await request('/v1/evidence')).status).toBe(401);
  } finally { app.close(); }
  expect(isHeld(join(home,'owner-ui.lock.sqlite'))).toBe(false);
  expect(isHeld(sharedServerLock(join(home,'vault')))).toBe(false);
});

test('one owner interface per directory and one server per vault, across processes, each freed the moment its holder dies', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shared-owner-')), root = join(home, 'vault');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'vault.yaml'), 'shared: true\n');
  const owner = initMemberStore(join(home, 'members.json'), root, { handle: 'owner' });
  writeFileSync(join(home, 'owner.json'), JSON.stringify({ name: 'Example team', token: owner.token }), { mode: 0o600 });
  const other = await holdElsewhere('sharedOwner.ts', 'sharedOwner', [home, assets]);
  try { expect(() => sharedOwner(home, assets)).toThrow('An owner interface is already running for this directory.'); }
  finally { await other.kill(); }
  const server = await holdElsewhere('sharedVault.ts', 'holdSharedVault', [root]);
  try {
    expect(() => sharedOwner(home, assets)).toThrow('The shared vault is already being served. Stop that server first.');
    expect(isHeld(join(home, 'owner-ui.lock.sqlite'))).toBe(false); // the refused interface let its own lock go
  } finally { await server.kill(); }
  const app = sharedOwner(home, assets);
  try { expect(isHeld(sharedServerLock(root))).toBe(true); }
  finally { app.close(); }
});
