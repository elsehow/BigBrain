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
import {unionGraph,unionRecent,unionNote,sharedEntityClaims} from '../lib/sharedReadUnion';
import {assertionEntityId} from '../lib/assertionLog';
import {appendEntityAliasEvent,createEntityAliasEvent} from '../lib/entityAliasLog';
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
 const withMemories={...graph,nodes:[...graph.nodes,{id:'related-memory',title:'Project memory',group:'memory',degree:1,path:'memories/project.md'},{id:'unrelated-memory',title:'Other memory',group:'memory',degree:0,path:'memories/other.md'}],edges:[{source:'related-memory',target:'personal-node'}],hash:'memories'};
 const scoped=await unionGraph(personal,withMemories,[c.id]);expect(scoped.nodes.some(n=>n.id==='related-memory')).toBe(true);expect(scoped.nodes.some(n=>n.id==='unrelated-memory')).toBe(false);expect(scoped.edges.some(e=>e.source==='related-memory'&&e.target.includes(c.id))).toBe(true);
 const recents=await unionRecent(personal,[],0,40,0);expect(recents.recent.map(r=>r.title)).toEqual(['Remote only']);
 const remotePath=`shared/${c.id}/${other.id}.md`;expect((await unionNote(remotePath))?.content).toContain('Remote evidence');
 const mine=vault.contributions(verified.actor).find(x=>x.insertion_id===other.id)!;vault.transitionContribution(verified.actor,mine.id,'withdrawn',{request_id:'withdraw-example',version:0});await expect(unionNote(remotePath)).rejects.toThrow();
 const own=vault.contributions(verified.actor).find(x=>x.insertion_id===sharedCopy.id)!;vault.transitionContribution(verified.actor,own.id,'withdrawn',{request_id:'withdraw-copy-example',version:0});expect((await unionGraph(personal,graph)).nodes).toHaveLength(1);
 writeFileSync(join(dir,'checked.txt'),'original retained');
 }finally{server.stop(true);if(old===undefined)delete process.env.BIGBRAIN_SHARED_CONNECTIONS;else process.env.BIGBRAIN_SHARED_CONNECTIONS=old;}
});
test('a memory folded from a joined vault\'s claims stands beside their entities, in the union and in that vault alone',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'union-memory-')),personal=join(dir,'personal'),shared=join(dir,'shared'),members=join(dir,'members.json'),store=join(dir,'connections.json');for(const root of [personal,shared])mkdirSync(root);
 const owner=initMemberStore(members,shared,{handle:'owner'}),verified=verifyCredential(members,owner.token);if(!verified.ok)throw Error('auth');const vault=new SharedVault(shared);
 const evidence=vault.dropEvidence(verified.actor,{title:'Kickoff notes',body:'The Example project kicked off.'}).insertion;
 const claim=vault.assert(verified.actor,{text:'[[Example project]] kicked off.',sources:[evidence.id]});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:makeSharedApiHandler({root:shared,storePath:members,vault,log:()=>{}})});const old=process.env.BIGBRAIN_SHARED_CONNECTIONS;process.env.BIGBRAIN_SHARED_CONNECTIONS=store;
 try{
 const c=await saveConnection(store,{name:'Example',endpoint:`http://127.0.0.1:${server.port}`,token:owner.token});
 mkdirSync(join(personal,'memory'));writeFileSync(join(personal,'memory','project.md'),`# Project\n\n- The Example project kicked off. [[shared:${c.id}:${claim.assertion.id}]]\n`);
 const graph={nodes:[{id:'project-memory',title:'Project',group:'memory',degree:0,path:'memory/project.md'},{id:'other-memory',title:'Other',group:'memory',degree:0,path:'memory/other.md'}],edges:[],hash:'example'};
 const entity=`shared:${c.id}:${claim.assertion.entities[0]!.id}`;
 expect((await unionGraph(personal,graph)).edges).toContainEqual({source:'project-memory',target:entity});
 const focused=await unionGraph(personal,graph,[c.id]);
 expect(focused.nodes.map(n=>n.id)).toContain('project-memory');expect(focused.nodes.map(n=>n.id)).not.toContain('other-memory');
 expect(focused.edges).toContainEqual({source:'project-memory',target:entity});
 }finally{server.stop(true);if(old===undefined)delete process.env.BIGBRAIN_SHARED_CONNECTIONS;else process.env.BIGBRAIN_SHARED_CONNECTIONS=old;}
});
test('an entity is one entity in every vault: a joined vault\'s mentions, by name or by your alias, land on yours',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'union-entity-')),personal=join(dir,'personal'),shared=join(dir,'shared'),members=join(dir,'members.json'),store=join(dir,'connections.json');for(const root of [personal,shared])mkdirSync(root);
 const owner=initMemberStore(members,shared,{handle:'owner'}),verified=verifyCredential(members,owner.token);if(!verified.ok)throw Error('auth');const vault=new SharedVault(shared);
 const notes=vault.dropEvidence(verified.actor,{title:'Planning notes',body:'Avery and Bo planned the launch.'}).insertion;
 const byName=vault.assert(verified.actor,{text:'[[Avery Quill]] planned the launch.',sources:[notes.id]});
 const byAlias=vault.assert(verified.actor,{text:'[[Ave]] booked the venue.',sources:[notes.id]});
 vault.assert(verified.actor,{text:'[[Bo Lark]] joined the launch.',sources:[notes.id]});
 const avery={id:assertionEntityId('Avery Quill'),label:'Avery Quill'};
 appendEntityAliasEvent(personal,createEntityAliasEvent({alias:'Ave',entity:avery,author:{kind:'user',id:'owner'},created_at:'2026-08-20T10:00:00.000Z',produced_by:{procedure:'test',version:'v1'}}));
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:makeSharedApiHandler({root:shared,storePath:members,vault,log:()=>{}})});const old=process.env.BIGBRAIN_SHARED_CONNECTIONS;process.env.BIGBRAIN_SHARED_CONNECTIONS=store;
 try{
 const c=await saveConnection(store,{name:'Example',endpoint:`http://127.0.0.1:${server.port}`,token:owner.token});
 const graph={nodes:[{id:avery.id,title:'Avery Quill',group:'entity',entity:true as const,degree:0,path:`projection/entities/${avery.id}.md`}],edges:[],hash:'entity'};
 const merged=await unionGraph(personal,graph);
 const entities=merged.nodes.filter(n=>n.entity);
 // Avery once (named and aliased there, both yours); Bo, yours to see but only theirs
 expect(entities.map(n=>n.title).sort()).toEqual(['Avery Quill','Bo Lark']);
 const mine=entities.find(n=>n.id===avery.id)! as typeof entities[number]&{vaults:string[]};
 expect(mine.vaults).toEqual(['personal',c.id]);
 // its two mentions there cite one source: one tie, drawn heavier, counted once
 const ties=merged.edges.filter(e=>e.source===avery.id||e.target===avery.id);
 expect(ties).toHaveLength(1);expect(ties[0]!.weight).toBe(2);expect(mine.degree).toBe(1);
 expect(entities.find(n=>n.title==='Bo Lark')!.id).toStartWith(`shared:${c.id}:`);
 // opening it: their claims beside yours, each marked with the vault
 const claims=(await sharedEntityClaims(personal,[avery.id])).get(avery.id)!;
 expect(claims.map(a=>a.id).sort()).toEqual([byName.assertion.id,byAlias.assertion.id].sort());
 expect(claims.every(a=>a.vault?.id===c.id&&a.vault.name===c.name)).toBe(true);
 expect(claims.flatMap(a=>a.sources.map(s=>s.path))).toContain(`shared/${c.id}/${notes.id}.md`);
 }finally{server.stop(true);if(old===undefined)delete process.env.BIGBRAIN_SHARED_CONNECTIONS;else process.env.BIGBRAIN_SHARED_CONNECTIONS=old;}
});
