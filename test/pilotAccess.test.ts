import {afterEach,expect,test} from 'bun:test';
import {existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {PilotAccess} from '../lib/pilotAccess';
import {PilotChats} from '../lib/pilotChat';
import {newPilotChatSession} from '../lib/pilotChatTypes';
import type {SessionAccess} from '../lib/workAccess';
const newSessionAccess = (): SessionAccess => ({ revision: 1, unrestricted: false, grants: [], requests: [], history: [], revoked: [] });
import {readWorkPermissions,saveWorkPermissions} from '../lib/workPermissions';
import {writeEnvValues} from '../lib/envFile';
import {nativeVault} from './support/vault';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=nativeVault({files:{'.env':'OPENAI_API_KEY=sk-test\nBIGBRAIN_PILOT_ENABLED=true\n','notes/project.md':'Project facts'}}); roots.push(root);
 const project=realpathSync(nativeVault({files:{'README.md':'project readme'}}));roots.push(project);
 const access=new PilotAccess(root), session=newPilotChatSession([]), signal=new AbortController().signal;
 return {root,project,access,session,call:(name:string,args:Record<string,unknown>={})=>access.tool(session,name,args,signal)};
}
test('Pilot reads configured folders immediately; scratch is the only writable location',async()=>{
 const f=fixture(); saveWorkPermissions(f.root,{version:2,folders:[{path:f.project,access:'read'}]});
 expect(await f.call('list_directories')).toMatchObject({folders:[{path:f.project,access:'read'}]});
 expect(await f.call('read_file',{path:join(f.project,'README.md')})).toMatchObject({text:'project readme'});
 expect(await f.call('read_file',{path:join(f.root,'notes/project.md')})).toMatchObject({text:'Project facts'});
 await f.call('write_scratch',{path:'handoff/context.md',text:'Evidence packet'});
 expect(await f.call('read_file',{path:'handoff/context.md',offset:9,limit:6})).toMatchObject({text:'packet',more:false});
 for(const path of [join(f.root,'notes/project.md'),join(f.project,'README.md'),'../escape.md'])await expect(f.call('write_scratch',{path,text:'no'})).rejects.toThrow('scratch');
 expect(readFileSync(join(f.project,'README.md'),'utf8')).toBe('project readme');
 saveWorkPermissions(f.root,{version:2,folders:[]});
 await expect(f.call('read_file',{path:join(f.project,'README.md')})).rejects.toThrow('not readable');
});
test('file tools deny symlink escapes, hard links, secrets and other Pilots scratch',async()=>{
 const f=fixture(),scratch=f.access.scratch(f.session);
 symlinkSync(f.project,join(scratch,'escape'));
 await expect(f.call('read_file',{path:'escape/README.md'})).rejects.toThrow('not readable');
 await expect(f.call('write_scratch',{path:'escape/README.md',text:'no'})).rejects.toThrow('scratch');
 linkSync(join(f.project,'README.md'),join(scratch,'hardlink'));
 await expect(f.call('write_scratch',{path:'hardlink',text:'no'})).rejects.toThrow('hard-linked');
 await expect(f.call('read_file',{path:'hardlink'})).rejects.toThrow('hard-linked');
 expect(readFileSync(join(f.project,'README.md'),'utf8')).toBe('project readme');
 const other=f.access.scratch(newPilotChatSession([]));writeFileSync(join(other,'private.txt'),'private');
 for(const path of [join(f.root,'.env'),join(other,'private.txt')])await expect(f.call('read_file',{path})).rejects.toThrow('not readable');
 const listing=await f.call('list_files',{path:scratch}) as {entries:{name:string}[]};
 expect(listing.entries.map(e=>e.name)).not.toContain('escape');
});
test('secret-bearing names and .git are unreadable in any authorized folder; env samples stay readable',async()=>{
 const f=fixture(),samples=['.env.example','.env.sample','.gitignore','.github/workflows/ci.yml','keys.md'];
 const secrets=['.env','.env.local','.envrc','server.pem','tls.key','client.p12','client.pfx','id_rsa','id_rsa.pub','id_ed25519','id_ecdsa','id_dsa.pub',
  '.npmrc','.netrc','.pypirc','.git-credentials','.pgpass','.htpasswd','credentials.json','service-account-prod.json','nested/.env.production','.env.d/token',
  '.git/config','vendor/lib/.git/config'];
 for(const name of [...secrets,...samples]){mkdirSync(dirname(join(f.project,name)),{recursive:true});writeFileSync(join(f.project,name),'invented value');}
 saveWorkPermissions(f.root,{version:2,folders:[{path:f.project,access:'read'}]});
 for(const name of secrets)await expect(f.call('read_file',{path:join(f.project,name)})).rejects.toThrow('not readable');
 for(const name of samples)expect(await f.call('read_file',{path:join(f.project,name)})).toMatchObject({text:'invented value'});
 expect(await f.call('read_file',{path:join(f.project,'README.md')})).toMatchObject({text:'project readme'});
 const listing=await f.call('list_files',{path:f.project}) as {entries:{name:string}[]};
 expect(listing.entries.map(e=>e.name).sort()).toEqual(['.env.example','.env.sample','.github','.gitignore','README.md','keys.md','nested','vendor']);
 expect(await f.call('list_files',{path:join(f.project,'vendor','lib')})).toMatchObject({entries:[]});
});
test('home credential stores stay unreadable, through links and from a vault kept at HOME',async()=>{
 const home=mkdtempSync(join(tmpdir(),'bb-permissions-home-'));roots.push(home);
 const child=Bun.spawn([process.execPath,join(import.meta.dir,'support/permissionsHome.ts'),'credentials'],{env:{...process.env,HOME:home},stdout:'pipe',stderr:'pipe'});
 const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect({code,stderr}).toEqual({code:0,stderr:''});
 expect(stdout).toContain('credentials ok');
},20000);
test('revoked or replaced directory aliases cannot extend readable access',async()=>{
 const f=fixture(),link=join(f.root,'folder');symlinkSync(f.project,link);
 saveWorkPermissions(f.root,{version:2,folders:[{path:link,access:'read'}]});
 expect(await f.call('read_file',{path:join(link,'README.md')})).toMatchObject({text:'project readme'});
 rmSync(link);symlinkSync('/etc',link);
 await expect(f.call('read_file',{path:join(link,'hosts')})).rejects.toThrow('not readable');
});
test('reads and writes are bounded, cancellable, and reject special files',async()=>{
 const f=fixture();await f.call('write_scratch',{path:'text',text:'abcdef'});
 expect(await f.call('read_file',{path:'text',limit:3})).toMatchObject({text:'abc',nextOffset:3,more:true});
 await expect(f.call('read_file',{path:'text',limit:64001})).rejects.toThrow('limit');
 await expect(f.call('write_scratch',{path:'huge',text:'a'.repeat(1_000_001)})).rejects.toThrow('1 MB');
 expect(existsSync(join(f.access.scratch(f.session),'huge'))).toBe(false);
 await expect(f.access.tool(f.session,'write_scratch',{path:'canceled',text:'no'},AbortSignal.abort())).rejects.toThrow();
 await expect(f.call('read_file',{path:f.access.scratch(f.session)})).rejects.toThrow('regular');
});
test('legacy settings become read-only and old pending approvals cannot block restored Pilots',()=>{
 const f=fixture();saveWorkPermissions(f.root,{version:2,folders:[{path:f.project,access:'write'}]});
 const session=f.session;session.access=newSessionAccess();session.access.unrestricted=true;
 session.access.requests.push({id:'old',path:f.project,access:'write',reason:'old request',revision:0,status:'pending',created:new Date().toISOString()});
 session.browser={status:'pending',requestId:'old-browser',reason:'old request'};
 session.githubRequest={id:'old-github',reason:'old request',status:'pending'};
 const dir=join(f.root,'.spool','pilot-chats');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,session.id+'.json'),JSON.stringify(session));
 const chats=new PilotChats(f.root,{graph:()=>[]});
 try{
  const restored=chats.get(session.id);
  expect(restored.access).toBeUndefined();expect(restored.browser).toBeUndefined();expect(restored.githubRequest).toBeUndefined();
  expect(readWorkPermissions(f.root).folders).toEqual([{path:f.project,access:'read'}]);
 }finally{chats.close();}
});

test('missing historical folders do not prevent migration and never gain access',async()=>{
 const f=fixture(),missing=join(f.project,'removed');
 writeEnvValues(f.root,{BIGBRAIN_PILOT_AGENT_PERMISSIONS:JSON.stringify({version:2,folders:[{path:missing,access:'write'}],legacyCowboy:true})});
 const chats=new PilotChats(f.root,{graph:()=>[]});
 try {
  expect(readWorkPermissions(f.root)).toEqual({version:2,folders:[{path:missing,access:'read'}]});
  await expect(f.call('read_file',{path:join(missing,'secret')})).rejects.toThrow();
 }finally{chats.close();}
});
