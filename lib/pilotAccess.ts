/** Fixed Pilot filesystem boundary. No shell, per-task grants, or approvals. */
import { closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { spoolDir } from './spool';
import { canonicalWorkPath, containsPath, credentialPaths, secretName, validatedWorkPermissions, migratePilotReadSettings } from './workPermissions';
import type { PilotChatSession } from './pilotChatTypes';
const string = { type:'string' };
const tool = (name:string, description:string, properties:Record<string,unknown>, required:string[]=[]) => ({ type:'function' as const, name, description, strict:false, parameters:{type:'object',properties,required,additionalProperties:false} });
export const PILOT_LOCAL_TOOLS = [
  tool('list_directories','List the vault, your private scratch, and additional readable folders configured in Vault → Pilot settings.',{}),
  tool('list_files','List up to 200 entries in a readable directory. Relative paths refer to your scratch. Additional folders must be configured in Vault → Pilot settings; otherwise delegate to a agent session.',{path:string},['path']),
  tool('read_file','Read a bounded UTF-8 text file from your scratch or an approved folder. Use vault search/read tools for vault notes. Relative paths refer to scratch.',{path:string,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:64000}},['path']),
  tool('write_scratch','Write a UTF-8 text file inside your private scratch, creating parent folders as needed. Never writes vault notes or project files. Use drop/directive for vault contributions and your own external agent application for implementation.',{path:string,text:string},['path','text']),
];
type Readable = {roots:string[]; denied:string[]};
export class PilotAccess {
  constructor(private root:string) {}
  /** Keep old Settings folder selections readable; retire their write modes. */
  migrateSettings():void {
    migratePilotReadSettings(this.root);
  }
  migrate(s:PilotChatSession):void {
    // Session-only grants are not silently promoted to machine-wide Settings.
    delete s.access; delete s.browser; delete s.githubRequest; delete s.nativeRequests; delete s.nativeExecution;
    if(s.localCommand?.status==='running') s.localCommand.status='uncertain';
  }
  scratch(s:PilotChatSession):string {
    const path=join(canonicalWorkPath(join(spoolDir(this.root),'workspaces')),s.id);
    mkdirSync(path,{recursive:true,mode:0o700});
    if(realpathSync(path)!==resolve(path)) throw new Error('Pilot scratch must not be a symbolic link.');
    return path;
  }
  private roots(s:PilotChatSession):string[] { return [realpathSync(this.root),this.scratch(s),...validatedWorkPermissions(this.root).folders.map(f=>f.path)]; }
  /** Resolved once per call; a directory listing checks every entry against it. */
  private readable(s:PilotChatSession):Readable {
    return {roots:this.roots(s),denied:[...['.env','.git','.state','.spool'].map(p=>canonicalWorkPath(join(this.root,p))),...credentialPaths()]};
  }
  private unreadable(path:string,scratch:string,{roots,denied}:Readable):boolean {
    if(!roots.some(root=>containsPath(root,path))) return true;
    if(containsPath(scratch,path)) return false;
    // Secret-bearing names are refused at any depth, including as a directory.
    return denied.some(p=>containsPath(p,path)) || path.split(sep).some(secretName);
  }
  private path(s:PilotChatSession,value:unknown,write=false,readable?:Readable):string {
    if(typeof value!=='string' || !value || value.length>4000 || /[\x00-\x1f]/.test(value)) throw new Error('Provide a file path.');
    const scratch=this.scratch(s), path=canonicalWorkPath(isAbsolute(value)?value:resolve(scratch,value));
    if(write ? !containsPath(scratch,path) : this.unreadable(path,scratch,readable??this.readable(s)))
      throw new Error(write?'Pilot writes only to private scratch. Delegate project changes to a agent session.':'This path is not readable. Add its folder in Vault → Pilot settings, or delegate to a agent session.');
    return path;
  }
  reference(s:PilotChatSession):string {
    return `Pilot filesystem: ${JSON.stringify({scratch:this.scratch(s),readableFolders:this.roots(s)})}. Only scratch is writable. Additional read access is configured by the user in Vault → Pilot settings. Delegate execution, GitHub, and browser work to agent sessions.`;
  }
  async tool(s:PilotChatSession,name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown> {
    signal.throwIfAborted();
    if(name==='list_directories') return {vault:realpathSync(this.root),scratch:this.scratch(s),folders:validatedWorkPermissions(this.root).folders.map(f=>({path:f.path,access:'read'}))};
    const path=this.path(s,args.path,name==='write_scratch');
    if(name==='list_files') {
      const readable=this.readable(s), entries=readdirSync(path,{withFileTypes:true}).filter(entry=>{try {this.path(s,join(path,entry.name),false,readable); return true;}catch{return false;}});
      return {path,entries:entries.slice(0,200).map(e=>({name:e.name,type:e.isDirectory()?'directory':e.isSymbolicLink()?'symlink':'file'})),truncated:entries.length>200};
    }
    if(name==='read_file') {
      const offset=args.offset??0, limit=args.limit??16000;
      if(!Number.isSafeInteger(offset) || (offset as number)<0 || !Number.isInteger(limit) || (limit as number)<1 || (limit as number)>64000) throw new Error('Use a nonnegative byte offset and a limit of 1–64,000 bytes.');
      const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const stat=fstatSync(fd);
        if(!stat.isFile() || stat.nlink>1) throw new Error('Choose a regular, non-hard-linked text file.');
        const buffer=Buffer.alloc(limit as number), count=readSync(fd,buffer,0,buffer.length,offset as number), data=buffer.subarray(0,count);
        if(data.includes(0)) throw new Error('This is not a text file.');
        return {path,text:data.toString('utf8'),nextOffset:(offset as number)+count,more:(offset as number)+count<stat.size};
      }finally{closeSync(fd);}
    }
    if(name==='write_scratch') {
      if(typeof args.text!=='string' || Buffer.byteLength(args.text)>1_000_000) throw new Error('Provide text up to 1 MB.');
      mkdirSync(dirname(path),{recursive:true,mode:0o700});
      this.path(s,path,true);
      const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
      try {
        const stat=fstatSync(fd); if(!stat.isFile() || stat.nlink>1) throw new Error('Choose a regular, non-hard-linked scratch file.');
        // Check before truncating so a hard link cannot modify an outside file.
        signal.throwIfAborted(); ftruncateSync(fd,0); writeFileSync(fd,args.text);
      }finally{closeSync(fd);}
      return {path,bytes:Buffer.byteLength(args.text)};
    }
    throw new Error('Unknown Pilot file tool.');
  }
}
