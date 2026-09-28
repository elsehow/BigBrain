import { afterEach, expect, test } from 'bun:test';
import { realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Projects } from '../lib/worker/projects';
import { agentOrchestrationRoutes } from '../lib/agentOrchestrationRoutes';
import { mdVault } from './support/vault';
const dirs:string[]=[];afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
const dir=()=>{const p=realpathSync(mdVault());dirs.push(p);return p;};
test('project authority rejects vault aliases, broad roots, local/wildcard domains and ungranted accounts',()=>{
 const root=dir(),p=dir(),store=new Projects(root),base={label:'Demo',path:p,mode:'read',references:[],domains:[],accounts:[]};
 for(const path of [root,homedir(),'/'])expect(()=>store.save({...base,path})).toThrow();
 symlinkSync(root,join(p,'vault'));expect(()=>store.save({...base,path:join(p,'vault')})).toThrow();
 for(const domain of ['localhost','127.0.0.1','*.example.com','https://example.com','host.local'])expect(()=>store.save({...base,domains:[domain]})).toThrow();
 expect(()=>store.save({...base,accounts:[{integration:'email',account:'missing@example.com'}]})).toThrow();
 const project=store.save(base);expect(new Projects(root).get(project.id)).toEqual(project);
});
test('only JSON from the app origin can save or revoke project authority',async()=>{
 const store=new Projects(dir()),project=dir(),route=agentOrchestrationRoutes(store).find(r=>r.path.endsWith('/save'))!;
 async function call(headers:Record<string,string>,body:unknown){const req=Object.assign(new PassThrough(),{headers:{host:'localhost:4747',...headers}});let status=0;const res={writeHead:(s:number)=>status=s,end:()=>{}};const done=route.handler({req,res,url:new URL('http://localhost:4747/api/agent-orchestration/save')} as never);req.end(JSON.stringify(body));await done;return status;}
 const body={label:'Example',path:project,mode:'read'};
 expect(await call({'content-type':'text/plain'},body)).toBe(415);expect(await call({'content-type':'application/json',origin:'https://outside.example'},body)).toBe(403);expect(store.list()).toEqual([]);
 expect(await call({'content-type':'application/json',origin:'http://localhost:4747'},body)).toBe(200);expect(store.list()).toHaveLength(1);
});

test('project environments retain network and credential names without exposing credential values', async()=>{
 const {readFileSync,statSync}=await import('node:fs');
 const {covers}=await import('../lib/worker/projects');
 const root=dir(),path=dir(),store=new Projects(root);
 store.connect(path,{GH_TOKEN:'synthetic-token',NPM_TOKEN:'synthetic-package-token'});
 const p=store.save({label:'Atlas',path,mode:'work',network:'public',credentials:['GH_TOKEN'],model:{adapter:'pi',provider:'anthropic',model:'claude-sonnet-5'}});
 expect(p.network).toBe('public');expect(p.credentials).toEqual(['GH_TOKEN']);
 expect(JSON.stringify(store.list())).not.toContain('synthetic-token');
 expect(readFileSync(join(root,'.spool','projects.json'),'utf8')).not.toContain('synthetic-token');
 expect(statSync(join(root,'.spool','project-credentials.json')).mode & 0o777).toBe(0o600);
 const loaded=new Projects(root);expect(loaded.get(p.id)).toEqual(p);
 expect(loaded.credentials.values(path,['GH_TOKEN'])).toEqual({GH_TOKEN:'synthetic-token'});
 expect(covers(p,{...p,network:undefined,domains:['example.com']})).toBe(true);
 expect(covers({...p,network:undefined},p)).toBe(false);
 expect(covers({...p,credentials:[]},p)).toBe(false);
 store.connect(path,{GH_TOKEN:null});expect(store.get(p.id)?.credentials).toEqual([]);
 expect(()=>store.credentials.values(path,['GH_TOKEN'])).toThrow('Reconnect');
 store.remove(p.id);expect(store.credentials.names(path)).toEqual([]);
});
test('credential setup rejects runtime overrides and missing credentials; inspection runs no project commands',()=>{
 const store=new Projects(dir()),path=dir();
 for(const name of ['PATH','HOME','BASH_ENV','NODE_OPTIONS','DYLD_INSERT_LIBRARIES','GIT_CONFIG_COUNT','HTTPS_PROXY'])expect(()=>store.connect(path,{[name]:'synthetic'})).toThrow();
 expect(()=>store.save({label:'Atlas',path,mode:'work',credentials:['GH_TOKEN']})).toThrow('Reconnect');
 const inspection=store.inspect(path);expect(inspection.path).toBe(path);expect(inspection.credentials).toEqual([]);expect(inspection.tools.find(t=>t.name==='git')?.available).toBe(true);
});
