/** Explicit one-click registration using each installed client's own CLI. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ConnectedClients, type ClientKind } from './connectedClients';
import { jobsPath } from './preflight';
const choices = [{kind:'claude-code',name:'Claude Code',command:'claude'},{kind:'codex',name:'Codex',command:'codex'}] as const;
export class LocalClients {
  constructor(private clients:ConnectedClients,private deps={
    which:(command:string)=>Bun.which(command,{PATH:jobsPath()}),
    run:(command:string,args:string[])=>{execFileSync(command,args,{timeout:15000,stdio:'pipe',env:{...process.env,PATH:jobsPath()}});},
  }){}
  list(){const clients=this.clients.list();return choices.map(c=>({...c,available:!!this.deps.which(c.command),connected:clients.some(v=>v.managedBy==='local:'+c.kind&&!v.revoked)}));}
  set(kind:unknown,enabled:unknown){
    const choice=choices.find(c=>c.kind===kind);
    if(!choice||typeof enabled!=='boolean')throw Error('Choose a local client and access setting.');
    const managedBy='local:'+choice.kind;
    const history=this.clients.list().filter(c=>c.managedBy===managedBy);
    const prior=history.find(c=>!c.revoked);
    if(!enabled){if(prior)this.clients.revoke(prior.id);return this.list();}
    if(prior)return this.list();
    const executable=this.deps.which(choice.command);
    if(!executable)throw Error(`Install ${choice.name} first.`);
    const setup=this.clients.create({name:choice.name+' on this computer',kind:choice.kind as ClientKind,managedBy});
    const entry=setup.configuration.mcpServers.bigbrain;
    // Do not replace a plugin, another vault, or a manually configured "bigbrain" entry.
    const server='bigbrain-'+createHash('sha256').update(this.clients.root).digest('hex').slice(0,12);
    // Claude refuses to add over an existing entry. Reconnect replaces only
    // the server this vault previously installed; other MCP entries are untouched.
    if(history.length){
      try{this.deps.run(executable,['mcp','remove',server,...(choice.kind==='claude-code'?['--scope','user']:[])]);}
      catch{/* It may already have been removed. The add below must still succeed. */}
    }
    const env=Object.entries(entry.env).flatMap(([k,v])=>['--env',`${k}=${v}`]);
    const args=choice.kind==='claude-code'
      ? ['mcp','add','--scope','user',...env,'--transport','stdio',server,'--',entry.command,...entry.args]
      : ['mcp','add',server,...env,'--',entry.command,...entry.args];
    try{this.deps.run(executable,args);}
    catch{this.clients.revoke(setup.id);throw Error(`Could not configure ${choice.name}. Retry, or use manual setup in Connected Clients.`);}
    return this.list();
  }
}
