import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sharedOwner } from '../lib/sharedOwner';
import { revokeMember } from '../lib/sharedMembers';
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
  expect(existsSync(join(home,'owner-ui.lock'))).toBe(false);
});
