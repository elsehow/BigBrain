import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initMemberStore,addMember,mintCredential} from '../lib/sharedMembers';
import {makeSharedApiHandler} from '../lib/sharedVaultApi';
import {issueSharedInvite} from '../lib/sharedInvites';
test('own contributions, repeated requests, another contributor, withdrawal guard, replay and restoration',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'contributions-')),root=join(dir,'vault'),store=join(dir,'members.json');mkdirSync(root);
 const owner=initMemberStore(store,root,{handle:'owner'});addMember(store,{handle:'alice',permissions:['read','write']});const alice=mintCredential(store,'alice',{name:'laptop'});
 let handler=makeSharedApiHandler({root,storePath:store,log:()=>{}});
 const call=async(token:string,path:string,body?:unknown)=>handler(new Request('http://test'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}));
 const input={title:'Shared example',body:'Evidence about example systems',origin:{id:'example-source',author:'Writer'}};
 const a=await (await call(alice.token,'/v1/evidence',input)).json() as any;await call(owner.token,'/v1/evidence',input);
 const mine=await (await call(alice.token,'/v1/contributions')).json() as any;const c=mine.items[0];expect(c.other_contributors).toEqual(['owner']);
 const op={request_id:'withdraw-test',version:0};expect((await call(owner.token,`/v1/contributions/${c.id}/withdraw`,op)).status).toBe(403);
 expect((await call(alice.token,`/v1/contributions/${c.id}/withdraw`,op)).status).toBe(200);
 expect((await call(alice.token,'/v1/evidence/'+a.id)).status).toBe(404);
 expect((await call(alice.token,'/v1/evidence',input)).status).toBe(409);
 const rotated=mintCredential(store,'alice',{name:'phone'});expect((await call(rotated.token,'/v1/evidence',input)).status).toBe(409);
 handler=makeSharedApiHandler({root,storePath:store,log:()=>{}});
 const list=await (await call(owner.token,'/v1/evidence')).json() as any;expect(list.items.length).toBe(1);
 expect((await call(rotated.token,`/v1/contributions/${c.id}/restore`,{request_id:'restore-test',version:1})).status).toBe(200);
 await call(alice.token,`/v1/contributions/${c.id}/withdraw`,op); // stale retry must not undo restoration
 expect((await call(alice.token,'/v1/evidence/'+a.id)).status).toBe(200);
});
test('single use invitation returns remote identity and preserves member',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'invite-')),root=join(dir,'vault'),store=join(dir,'members.json');mkdirSync(root);initMemberStore(store,root,{handle:'owner'});
 const link=issueSharedInvite(store,'owner','https://vault.example.org'),secret=new URL(link).hash.slice(1),handler=makeSharedApiHandler({root,storePath:store,log:()=>{}});
 const request=()=>new Request('https://vault.example.org/v1/invites/redeem',{method:'POST',headers:{Authorization:`Bearer ${secret}`}});
 const r=await handler(request());expect(r.status).toBe(200);const body=await r.json() as any;expect(body.vault.name).toBe('Shared BigBrain');expect(body.token.startsWith('sv_')).toBe(true);expect((await handler(request())).status).toBe(401);
});
