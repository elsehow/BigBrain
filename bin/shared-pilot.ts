#!/usr/bin/env bun
/** Pilot launcher: a disposable local read projection over a personal vault,
 * backed by the authenticated remote connection store. Never writes the original. */
import {mkdirSync,existsSync,copyFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {flagValue,hasFlag} from '../lib/cliflags';
import {engineProcessEnv,handoffProcessEnv,NO_ENV_FILE} from '../lib/env';
import {viewerLink,viewerReady} from '../lib/viewerSession';
import {tryHold} from '../lib/sqliteLock';
const args=process.argv.slice(2),source=flagValue(args,'personal'),location=flagValue(args,'home');
if(!source||!location)throw Error('Use --personal <existing vault> --home <private pilot directory> [--port 4778] [--open]');
const home=resolve(location),original=resolve(source),personal=join(home,'personal'),port=Number(flagValue(args,'port')??4778);
if(original===personal||!existsSync(join(original,'vault.yaml')))throw Error('Choose an existing personal vault and a separate pilot home');
mkdirSync(home,{recursive:true,mode:0o700});mkdirSync(personal,{recursive:true,mode:0o700});
// The viewer answers only its session (lib/viewerSession.ts): open a short-lived link once it is up.
const open=async()=>{if(!hasFlag(args,'open'))return;const secret=await viewerReady(port);if(!secret)return console.error('The viewer did not answer; open it with: bigbrain open --port '+port);Bun.spawn(['open',viewerLink(port,secret)+'#sharedVaultSettings'],{env:handoffProcessEnv(),stdout:'ignore',stderr:'ignore'});};
const lock=tryHold(join(home,'pilot.lock.sqlite'),{retired:join(home,'pilot.lock')});
if(!lock){await open();process.exit(0);}
let copying=false;
async function refresh(){if(copying)return;copying=true;try{for(const kind of ['insertions','assertions','revocations','entity-aliases']){const from=join(original,'log',kind);if(!existsSync(from))continue;const to=join(personal,'log',kind);mkdirSync(to,{recursive:true,mode:0o700});const p=Bun.spawn(['rsync','-a','--ignore-existing',from+'/',to+'/'],{env:handoffProcessEnv(),stdout:'ignore',stderr:'inherit'});if(await p.exited!==0)throw Error('Could not refresh the personal read snapshot');}}finally{copying=false;}}
let child:ReturnType<typeof Bun.spawn>|undefined;let timer:ReturnType<typeof setInterval>|undefined;
const stop=()=>{if(timer)clearInterval(timer);child?.kill();lock.release();};process.on('SIGTERM',()=>{stop();process.exit()});process.on('SIGINT',()=>{stop();process.exit()});
try{
 await refresh();if(!existsSync(join(personal,'vault.yaml')))copyFileSync(join(original,'vault.yaml'),join(personal,'vault.yaml'));
 // Runtime flags and credentials never go into the source vault.
 writeFileSync(join(home,'README.txt'),'Shared vault pilot. personal/ is a read snapshot; original vault is never modified. Stop the launcher to stop background inclusion. Credentials and Jev API key are private files in this directory.\n',{mode:0o600});
 child=Bun.spawn(['bun',NO_ENV_FILE,'web/server.ts'],{cwd:resolve(import.meta.dir,'..'),env:{...engineProcessEnv(),BIGBRAIN_VAULT:personal,BIGBRAIN_WEB_PORT:String(port),BIGBRAIN_SHARED_CONNECTIONS:join(home,'connections.json')},stdout:'inherit',stderr:'inherit'});
 timer=setInterval(()=>void refresh().catch(()=>console.error('Personal snapshot refresh failed; will retry.')),30000);
 console.log(`Shared vault pilot: http://127.0.0.1:${port}/#sharedVaultSettings`);void open();await child.exited;
}finally{stop();}
