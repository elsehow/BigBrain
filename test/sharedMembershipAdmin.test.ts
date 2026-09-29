import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initMemberStore,listMembers,mintCredential} from '../lib/sharedMembers';
import {makeSharedApiHandler} from '../lib/sharedVaultApi';

test('owner invitations, member attribution, access changes and all-device revocation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bb-members-admin-')),root=join(dir,'vault'),store=join(dir,'members.json');mkdirSync(root);
 try{
 const owner=initMemberStore(store,root,{handle:'owner'});let now=new Date();
 let handler=makeSharedApiHandler({root,storePath:store,now:()=>now,log:()=>{}});
 const call=(path:string,token=owner.token,body?:unknown)=>handler(new Request('http://localhost'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}));
 const create=async(name:string,permission='write')=>{const r=await call('/v1/invites',owner.token,{name,permission});expect(r.status).toBe(201);return r.json();};
 const redeem=(secret:string)=>call('/v1/invites/redeem',secret,{});
 const invite=await create('Mara');expect(listMembers(store)).toHaveLength(1);
 // Durable pending invitation, no member or device minted yet.
 handler=makeSharedApiHandler({root,storePath:store,now:()=>now,log:()=>{}});
 expect((await (await call('/v1/members')).json()).invites[0].secret).toBe(invite.secret);
 const accepted=await redeem(invite.secret);expect(accepted.status).toBe(200);const {token}=await accepted.json();
 expect((await redeem(invite.secret)).status).toBe(401);
 const who=await (await call('/v1/whoami',token)).json();expect(who.role).toBe('member');expect(who.member_id).not.toBe(owner.member.id);
 const second=mintCredential(store,who.handle,{name:'Second device'});
 for(const t of [token,second.token]){
  expect((await call('/v1/members',t)).status).toBe(403);
  expect((await call('/v1/invites',t,{name:'Other',permission:'write'})).status).toBe(403);
  expect((await call(`/v1/members/${owner.member.id}/remove`,t,{})).status).toBe(403);
  expect((await call(`/v1/members/${who.member_id}/access`,t,{permission:'write'})).status).toBe(403);
  expect((await call(`/v1/invites/${invite.id}/cancel`,t,{})).status).toBe(403);
 }
 const evidence=await (await call('/v1/evidence',token,{title:'Example notes',body:'An invented observation.'})).json();
 const assertion=await (await call('/v1/assertions',token,{text:'An invented observation.',sources:[evidence.id]})).json();
 expect((await call(`/v1/members/${who.member_id}/access`,owner.token,{permission:'read'})).status).toBe(200);
 for(const t of [token,second.token])expect((await call('/v1/evidence',t,{title:'Forbidden',body:'No write.'})).status).toBe(403);
 expect((await call(`/v1/members/${who.member_id}/access`,owner.token,{permission:'write'})).status).toBe(200);
 expect((await call('/v1/evidence',token,{title:'Allowed again',body:'New source.'})).status).toBe(201);
 expect((await call(`/v1/members/${who.member_id}/remove`,owner.token,{})).status).toBe(200);
 for(const t of [token,second.token])expect((await call('/v1/whoami',t)).status).toBe(401);
 const saved=await (await call('/v1/assertions/'+assertion.id)).json();expect(saved.assertion.author.id).toBe(who.handle);
 expect((await call('/v1/evidence/'+evidence.id)).status).toBe(200);
 for(const action of ['remove','access'])expect((await call(`/v1/members/${owner.member.id}/${action}`,owner.token,{permission:'read'})).status).toBe(400);
 const cancelled=await create('Jules');expect((await call(`/v1/invites/${cancelled.id}/cancel`,owner.token,{})).status).toBe(200);expect((await redeem(cancelled.secret)).status).toBe(401);
 const expired=await create('Ren');now=new Date(now.getTime()+86400001);expect((await redeem(expired.secret)).status).toBe(401);
 const read=await create('Lee','read'),r=await (await redeem(read.secret)).json(),rw=await (await call('/v1/whoami',r.token)).json();expect(rw.permissions).toEqual(['read']);
 await call(`/v1/members/${rw.member_id}/access`,owner.token,{permission:'write'});expect((await call('/v1/evidence',r.token,{title:'Upgraded',body:'Can now contribute.'})).status).toBe(201);
 expect((await call('/v1/members','invalid')).status).toBe(401);
 const delegate=mintCredential(store,'owner',{name:'Agent',kind:'agent'});expect((await call('/v1/members',delegate.token)).status).toBe(403);
 const restricted=mintCredential(store,'owner',{name:'Read device',scopes:['read']});expect((await call('/v1/members',restricted.token)).status).toBe(403);
 for(const body of [{name:'',permission:'write'},{name:'Name',permission:'owner'},{name:'x\ny',permission:'read'},null])expect((await call('/v1/invites',owner.token,body)).status).toBe(400);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
