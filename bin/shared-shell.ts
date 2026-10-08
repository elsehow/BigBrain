#!/usr/bin/env bun
/** Local owner preview using the production shell and an isolated personal
 * placeholder. Does not launch the installed app, Pilot, or a gardener. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { flagValue, hasFlag } from '../lib/cliflags';
import { writeAtomic } from '../lib/fsx';
import { engineProcessEnv, handoffProcessEnv, NO_ENV_FILE } from '../lib/env';
import { initMemberStore, verifyCredential } from '../lib/sharedMembers';
import { readConnections, saveConnection, sharedRequest } from '../lib/sharedConnections';
import { tryHold } from '../lib/sqliteLock';
import { vaultIdentity } from '../lib/vaultBoundary';
import { readViewerSession, viewerAuthorization, viewerLink } from '../lib/viewerSession';
const args = process.argv.slice(2), location = flagValue(args,'home');
if (!location) throw Error('Usage: bun bin/shared-shell.ts --home <owner-directory> [--port 4768] [--shared-port 4769] [--open]');
const home = resolve(location), port = Number(flagValue(args,'port') ?? 4768), remotePort = Number(flagValue(args,'shared-port') ?? 4769);
for (const value of [port,remotePort]) if (!Number.isInteger(value) || value<1 || value>65535) throw Error('Invalid port.');
mkdirSync(home,{recursive:true,mode:0o700});
const launch = join(home,'shell-launch-url');
// The viewer answers only its session (lib/viewerSession.ts): a browser gets a
// fresh short-lived link to the saved view, never the saved URL bare.
const open = (url:string) => {
  if (!hasFlag(args,'open')) return;
  const at = new URL(url), secret = readViewerSession(Number(at.port));
  const link = secret ? viewerLink(Number(at.port), secret) + at.search.replace(/^\?/, '&') : url;
  Bun.spawn([process.platform==='darwin'?'open':'xdg-open',link],{env:handoffProcessEnv(),stdout:'ignore',stderr:'ignore'});
};
const lock = tryHold(join(home,'shell-ui.lock.sqlite'), { retired: join(home,'shell-ui.lock') });
if (!lock) { if (existsSync(launch)) { open(readFileSync(launch,'utf8').trim()); process.exit(0); } throw Error('Shared shell is already starting.'); }
const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping=false;
const stop = () => { if(stopping)return;stopping=true;for(const child of children)child.kill();lock.release(); };
process.on('SIGTERM',()=>{stop();process.exit()});process.on('SIGINT',()=>{stop();process.exit()});
try {
  const root=join(home,'vault'),members=join(home,'members.json'),ownerPath=join(home,'owner.json'),personal=join(home,'preview-personal'),store=join(home,'shell-connections.json');
  if (!existsSync(ownerPath)) {
    if (existsSync(root)||existsSync(members)) throw Error('Existing vault has no saved owner credential. Use Connect shared vault in the normal shell.');
    mkdirSync(root,{mode:0o700});writeFileSync(join(root,'vault.yaml'),'shared: true\nintegrations: {}\n');
    const handle=flagValue(args,'owner') ?? userInfo().username.toLowerCase().replace(/[^a-z0-9_-]/g,'-');
    const owner=initMemberStore(members,root,{handle});
    writeAtomic(ownerPath,JSON.stringify({name:flagValue(args,'name')??'Shared BigBrain',token:owner.token}),0o600);
  }
  const saved=JSON.parse(readFileSync(ownerPath,'utf8')) as {name:string;token:string};
  const verified=verifyCredential(members,saved.token);
  if(!verified.ok||verified.actor.role!=='owner')throw Error('The saved owner credential is no longer authorized.');
  mkdirSync(personal,{recursive:true,mode:0o700});
  if(!existsSync(join(personal,'vault.yaml')))writeFileSync(join(personal,'vault.yaml'),'integrations: {}\n');
  const endpoint=`http://127.0.0.1:${remotePort}`;
  const remote=Bun.spawn(['bun','bin/shared.ts','serve','--vault',root,'--members',members,'--port',String(remotePort)],{cwd:resolve(import.meta.dir,'..'),stdin:'ignore',stdout:'ignore',stderr:'inherit'});children.push(remote);
  const probe={id:'probe',name:saved.name,endpoint,token:saved.token};
  let ready=false;
  for(let i=0;i<100;i++){if(remote.exitCode!==null)throw Error('Shared server could not start. Stop the earlier owner interface first.');try{await sharedRequest(probe,'/v1/whoami');ready=true;break}catch{await Bun.sleep(100)}}
  if(!ready)throw Error('Shared server did not become ready.');
  let connection=readConnections(store).find(c=>c.endpoint===endpoint&&c.token===saved.token);
  if(!connection){const created=await saveConnection(store,probe);connection=readConnections(store).find(c=>c.id===created.id)!;}
  const viewer=Bun.spawn(['bun',NO_ENV_FILE,'web/server.ts'],{cwd:resolve(import.meta.dir,'..'),env:{...engineProcessEnv(),BIGBRAIN_VAULT:personal,BIGBRAIN_WEB_PORT:String(port),BIGBRAIN_SHARED_CONNECTIONS:store},stdin:'ignore',stdout:'ignore',stderr:'inherit'});children.push(viewer);
  ready=false;
  for(let i=0;i<100;i++){if(viewer.exitCode!==null)throw Error('Viewer could not start.');try{const r=await fetch(`http://127.0.0.1:${port}/api/vault`,{headers:viewerAuthorization(port)});if(r.ok&&r.headers.get('x-bigbrain-vault')===vaultIdentity(personal)){ready=true;break}}catch{}await Bun.sleep(100)}
  if(!ready)throw Error('Viewer did not become ready.');
  const url=`http://127.0.0.1:${port}/?workspace=${connection.id}`;
  writeAtomic(launch,url+'\n',0o600);console.log(`Shared BigBrain: ${url}\nPersonal preview is isolated at ${personal}`);open(url);
  await Promise.race(children.map(child=>child.exited));
  if(!stopping)throw Error('A preview service stopped. Restart the launcher to reconnect.');
} finally { stop(); }
