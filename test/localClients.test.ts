import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { nativeVault } from './support/vault';
import { ConnectedClients } from '../lib/connectedClients';
import { LocalClients } from '../lib/localClients';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})));
function fixture(){const root=nativeVault();roots.push(root);return new ConnectedClients(root,join(root,'tokens.json'));}
test('local registration is scoped to a vault and explicit; repeats, revoke, reconnect and failure are safe',()=>{
 const clients=fixture(),calls:{command:string;args:string[]}[]=[];
 const local=new LocalClients(clients,{which:c=>'/bin/'+c,run:(command,args)=>{calls.push({command,args});}});
 expect(local.list().every(c=>!c.connected)).toBe(true);expect(clients.list()).toHaveLength(0);
 local.set('codex',true);const first=clients.list()[0]!;expect(local.list()[1]?.connected).toBe(true);
 expect(calls[0]?.args.slice(0,2)).toEqual(['mcp','add']);expect(calls[0]?.args[2]).toMatch(/^bigbrain-[a-f0-9]{12}$/);
 expect(calls[0]?.args).toContain(first.id);expect(calls[0]?.args.join(' ')).not.toContain('bb_');
 local.set('codex',true);expect(calls).toHaveLength(1);
 local.set('codex',false);expect(()=>clients.token(first.id)).toThrow('revoked');
 local.set('codex',true);expect(calls).toHaveLength(3);expect(calls[1]?.args).toEqual(['mcp','remove',calls[0]!.args[2]!]);expect(calls[2]?.args[2]).toBe(calls[0]?.args[2]);
 local.set('claude-code',true);expect(calls[3]?.args).toContain('user');
 local.set('claude-code',false);local.set('claude-code',true);
 expect(calls[4]?.args).toEqual(['mcp','remove',calls[3]!.args.find(a=>/^bigbrain-[a-f0-9]{12}$/.test(a))!,'--scope','user']);
 const failing=new LocalClients(fixture(),{which:()=>'/bin/codex',run:()=>{throw Error('private error');}});
 expect(()=>failing.set('codex',true)).toThrow('Could not configure');expect(failing.list().every(c=>!c.connected)).toBe(true);
 expect(()=>local.set('generic',true)).toThrow();
});
