import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sharedWorkspace } from '../lib/sharedWorkspace';
import { allowLoopbackRequest } from '../lib/httpx';
import { makeSharedApiHandler } from '../lib/sharedVaultApi';
import { initMemberStore, addMember, mintCredential, revokeCredential } from '../lib/sharedMembers';
import { saveConnection, endpointURL } from '../lib/sharedConnections';

test('shared shell adapter isolates records, protects credentials, and respects permissions and revocation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bb-shared-shell-')), root = join(home, 'vault'), members = join(home,'members.json'), store = join(home,'connections.json');
  mkdirSync(root); writeFileSync(join(root,'vault.yaml'), 'shared: true\n');
  const owner = initMemberStore(members, root, {handle:'owner'});
  addMember(members, {handle:'reader', permissions:['read'] });
  const reader = mintCredential(members, 'reader', {name:'reader device',kind:'person',scopes:['read']});
  const remote = Bun.serve({hostname:'127.0.0.1',port:0,fetch:makeSharedApiHandler({root,storePath:members,log:()=>{}})});
  let personalCalls = 0;
  const local = createServer(async (req,res) => { if (!allowLoopbackRequest(req,res)) return; if (await sharedWorkspace(req,res,store)) return; personalCalls++; res.end('personal sentinel'); });
  await new Promise<void>(r => local.listen(0,'127.0.0.1',r));
  const address = local.address() as {port:number}, base = `http://127.0.0.1:${address.port}`;
  const endpoint = `http://127.0.0.1:${remote.port}`;
  try {
    const connection = await saveConnection(store,{name:'Test team',endpoint,token:owner.token});
    const readonly = await saveConnection(store,{name:'Read only',endpoint,token:reader.token});
    expect(statSync(store).mode & 0o777).toBe(0o600);
    const request = (path:string,body?:unknown,id=connection.id,extra={}) => fetch(base+path,{headers:{'x-bigbrain-workspace':id,'content-type':'application/json',...extra},method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});
    const listing = await (await fetch(base+'/api/shared-connections')).text();
    expect(listing).not.toContain(owner.token); expect(listing).not.toContain(reader.token);
    expect((await request('/api/shared-connections',{name:'Bad',endpoint,token:owner.token},connection.id,{origin:'https://evil.example'})).status).toBe(403);
    const dropped = await request('/api/drop',{name:'Example launch',content:'The [[Example project]] launches next week.'});
    expect(dropped.status).toBe(200); const receipt = await dropped.json() as {path:string};
    const source = receipt.path.match(/(ins_[a-f0-9]+)\.json$/)![1];
    expect((await request('/api/shared/assertions',{text:'[[Example project]] launches next week.',sources:[source]})).status).toBe(200);
    const graph = await (await request('/api/graph')).json() as {nodes:Array<{title:string}>;edges:unknown[]};
    expect(graph.nodes.map(n=>n.title)).toContain('Example project'); expect(graph.edges).toHaveLength(1);
    const note = await (await request('/api/note?path='+encodeURIComponent(receipt.path))).json() as {content:string;sourceAssertions:unknown[]};
    expect(note.content).toContain('launches next week'); expect(note.sourceAssertions).toHaveLength(1);
    expect((await request('/api/search?q=launches')).status).toBe(200);
    for (const path of ['/api/config','/api/pilot/chat/send','/api/setup/vault','/api/enqueue']) expect((await request(path,{})).status).toBe(403);
    expect((await request('/api/note?path=../../personal.md')).status).toBe(404);
    expect((await request('/api/drop',{name:'Denied',content:'No'},readonly.id)).status).toBe(403);
    expect((await request('/api/graph',undefined,'missing')).status).toBe(404);
    expect((await request('/api/graph',undefined,connection.id,{'x-bigbrain-vault':'personal'})).status).toBe(409);
    expect(personalCalls).toBe(0);
    revokeCredential(members,owner.credential.id);
    expect((await request('/api/graph')).status).toBe(401);
    expect((await request('/api/drop',{name:'Denied',content:'Revoked'})).status).toBe(401);
    expect(personalCalls).toBe(0);
    expect((await fetch(base+'/api/graph')).status).toBe(200); expect(personalCalls).toBe(1);
  } finally { local.closeAllConnections(); local.close(); remote.stop(true); }
});

test('remote credentials require TLS except on loopback and cannot ride URLs', () => {
  for (const value of ['http://example.org','https://owner:secret@example.org','https://example.org/path','https://example.org?token=x']) expect(()=>endpointURL(value)).toThrow();
  expect(endpointURL('https://example.org')).toBe('https://example.org');
});
