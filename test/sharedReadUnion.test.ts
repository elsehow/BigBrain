import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initMemberStore,verifyCredential} from '../lib/sharedMembers';
import {SharedVault} from '../lib/sharedVault';
import {makeSharedApiHandler} from '../lib/sharedVaultApi';
import {saveConnection} from '../lib/sharedConnections';
import {sourceInsertion,appendSourceInsertionEvent,insertionEventRel} from '../lib/insertionLog';
import {sourceKey} from '../lib/sharedRules';
import {unionGraph,unionRecent,unionNote} from '../lib/sharedReadUnion';
test('combined reads link own copies, expose shared-only sources and preserve personal originals after withdrawal',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'union-')),personal=join(dir,'personal'),shared=join(dir,'shared'),members=join(dir,'members.json'),store=join(dir,'connections.json');for(const root of [personal,shared])mkdirSync(root);
 const source=sourceInsertion({id:'personal-example',title:'Local source',from:'Owner',from_kind:'person',source:'web'},'Example source body');appendSourceInsertionEvent(personal,source);
 const owner=initMemberStore(members,shared,{handle:'owner'}),verified=verifyCredential(members,owner.token);if(!verified.ok)throw Error('auth');const vault=new SharedVault(shared);
 const sharedCopy=vault.dropEvidence(verified.actor,{title:source.title,body:source.body,origin:{id:sourceKey(source)}}).insertion;
 const other=vault.dropEvidence(verified.actor,{title:'Remote only',body:'Remote evidence'}).insertion;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:makeSharedApiHandler({root:shared,storePath:members,vault,log:()=>{}})});const old=process.env.BIGBRAIN_SHARED_CONNECTIONS;process.env.BIGBRAIN_SHARED_CONNECTIONS=store;
 try{
 const c=await saveConnection(store,{name:'Example',endpoint:`http://127.0.0.1:${server.port}`,token:owner.token});
 const graph={nodes:[{id:'personal-node',title:source.title,group:'source',degree:0,path:insertionEventRel(source)}],edges:[],hash:'example'};
 const merged=await unionGraph(personal,graph);expect(merged.nodes).toHaveLength(2);expect(merged.nodes.filter(n=>n.title===source.title)).toHaveLength(1);
 expect(merged.nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y))).toBe(true);
 const focused=await unionGraph(personal,graph,[c.id]);expect(focused.nodes).toHaveLength(2);expect(focused.nodes.some(n=>n.id==='personal-node')).toBe(false);
 expect((await unionRecent(personal,[],0,40,0,[c.id])).recent).toHaveLength(2);
 expect((await unionGraph(personal,graph,['personal'])).nodes).toHaveLength(1);
 const recents=await unionRecent(personal,[],0,40,0);expect(recents.recent.map(r=>r.title)).toEqual(['Remote only']);
 const remotePath=`shared/${c.id}/${other.id}.md`;expect((await unionNote(remotePath))?.content).toContain('Remote evidence');
 const mine=vault.contributions(verified.actor).find(x=>x.insertion_id===other.id)!;vault.transitionContribution(verified.actor,mine.id,'withdrawn',{request_id:'withdraw-example',version:0});await expect(unionNote(remotePath)).rejects.toThrow();
 const own=vault.contributions(verified.actor).find(x=>x.insertion_id===sharedCopy.id)!;vault.transitionContribution(verified.actor,own.id,'withdrawn',{request_id:'withdraw-copy-example',version:0});expect((await unionGraph(personal,graph)).nodes).toHaveLength(1);
 writeFileSync(join(dir,'checked.txt'),'original retained');
 }finally{server.stop(true);if(old===undefined)delete process.env.BIGBRAIN_SHARED_CONNECTIONS;else process.env.BIGBRAIN_SHARED_CONNECTIONS=old;}
});
