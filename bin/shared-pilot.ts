#!/usr/bin/env bun
/** Pilot launcher: a disposable local read projection over a personal vault,
 * backed by the authenticated remote connection store. Never writes the original. */
import {mkdirSync,existsSync,copyFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {flagValue,hasFlag} from '../lib/cliflags';
import {acquire,release} from '../lib/pidLock';
const args=process.argv.slice(2),source=flagValue(args,'personal'),location=flagValue(args,'home');
if(!source||!location)throw Error('Use --personal <existing vault> --home <private pilot directory> [--port 4778] [--open]');
const home=resolve(location),original=resolve(source),personal=join(home,'personal'),port=Number(flagValue(args,'port')??4778);
if(original===personal||!existsSync(join(original,'vault.yaml')))throw Error('Choose an existing personal vault and a separate pilot home');
mkdirSync(home,{recursive:true,mode:0o700});mkdirSync(personal,{recursive:true,mode:0o700});
const lock=join(home,'pilot.lock');
const open=()=>{if(hasFlag(args,'open'))Bun.spawn(['open',`http://127.0.0.1:${port}/#sharedVaultSettings`],{stdout:'ignore',stderr:'ignore'});};
if(!acquire(lock)){open();process.exit(0);}
let copying=false;
async function refresh(){if(copying)return;copying=true;try{for(const kind of ['insertions','assertions','revocations','entity-aliases']){const from=join(original,'log',kind);if(!existsSync(from))continue;const to=join(personal,'log',kind);mkdirSync(to,{recursive:true,mode:0o700});const p=Bun.spawn(['rsync','-a','--ignore-existing',from+'/',to+'/'],{stdout:'ignore',stderr:'inherit'});if(await p.exited!==0)throw Error('Could not refresh the personal read snapshot');}}finally{copying=false;}}
let child:ReturnType<typeof Bun.spawn>|undefined;let timer:ReturnType<typeof setInterval>|undefined;
const stop=()=>{if(timer)clearInterval(timer);child?.kill();release(lock);};process.on('SIGTERM',()=>{stop();process.exit()});process.on('SIGINT',()=>{stop();process.exit()});
try{
 await refresh();if(!existsSync(join(personal,'vault.yaml')))copyFileSync(join(original,'vault.yaml'),join(personal,'vault.yaml'));
 // Runtime flags and credentials never go into the source vault.
 writeFileSync(join(home,'README.txt'),'Shared vault pilot. personal/ is a read snapshot; original vault is never modified. Stop the launcher to stop background inclusion. Credentials and Jev API key are private files in this directory.\n',{mode:0o600});
 child=Bun.spawn(['bun','web/server.ts'],{cwd:resolve(import.meta.dir,'..'),env:{...process.env,BIGBRAIN_VAULT:personal,BIGBRAIN_WEB_PORT:String(port),BIGBRAIN_SHARED_CONNECTIONS:join(home,'connections.json')},stdout:'inherit',stderr:'inherit'});
 timer=setInterval(()=>void refresh().catch(()=>console.error('Personal snapshot refresh failed; will retry.')),30000);
 console.log(`Shared vault pilot: http://127.0.0.1:${port}/#sharedVaultSettings`);open();await child.exited;
}finally{stop();}
