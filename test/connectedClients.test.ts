import { afterEach, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { rmSync, statSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { nativeVault } from './support/vault';
import { ConnectedClients, authenticateClient } from '../lib/connectedClients';
import { readSourceInsertionLog } from '../lib/insertionLog';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
function fixture(){const root=nativeVault({files:{'vault.yaml':'{}','memory/index.md':'# Memory\n\nA synthetic vault.'}});roots.push(root);return {root,clients:new ConnectedClients(root,join(root,'tokens.json'))};}
test('named client setup is private, per credential, and does not grant live access',()=>{
 const {clients}=fixture();const a=clients.create({name:'Work Codex',kind:'codex'}),b=clients.create({name:'Personal Claude',kind:'claude-code'});
 expect(a.id).not.toBe(b.id);expect(a.command).toContain("codex mcp add");expect(b.command).toStartWith("claude mcp remove --scope user bigbrain\nclaude mcp add --scope user");
 expect(JSON.stringify(clients.list())).not.toContain('bb_');expect(JSON.stringify(a)).not.toContain('bb_');
 expect(statSync(clients.store+'.clients/'+a.id+'.json').mode&0o777).toBe(0o600);
 clients.revoke(a.id);expect(()=>clients.token(a.id)).toThrow('revoked');expect(clients.token(b.id)).toStartWith('bb_');
 expect(clients.list().find(c=>c.id===a.id)?.revoked).toBeTruthy();
});
test('real stdio MCP authenticates all tools, attributes evidence, and revokes existing sessions',async()=>{
 const {root,clients}=fixture(),setup=clients.create({name:'Verified Codex',kind:'codex'});
 const client=new Client({name:'Spoofed name',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('bin/mcp.ts'),'--client',setup.id],env:{PATH:process.env.PATH!,HOME:process.env.HOME!,BIGBRAIN_VAULT:root,BIGBRAIN_TOKENS:clients.store},stderr:'pipe'});
 try{await client.connect(transport);expect((await client.listTools()).tools.map(t=>t.name)).toEqual(['load_memory','search_vault','read_note','drop']);
 const result=await client.callTool({name:'drop',arguments:{title:'Decision',body:'The user chose blue.'}});expect(result.isError).not.toBe(true);
 expect(readSourceInsertionLog(root).at(-1)?.envelope.from).toBe('Verified Codex');expect(clients.list()[0]?.lastUsed).toBeTruthy();
 clients.revoke(setup.id);expect((await client.callTool({name:'load_memory',arguments:{}})).isError).toBe(true);
 expect((await client.callTool({name:'drop',arguments:{title:'No',body:'No'}})).isError).toBe(true);expect(readSourceInsertionLog(root)).toHaveLength(1);
 }finally{await client.close();}
});
test('managed connections persist, refuse revoked reuse, and reconnect explicitly with no inherited live grants',()=>{
 const {clients}=fixture();const first=clients.ensure('Codex runner','codex','runner:codex');expect(clients.ensure('Codex runner','codex','runner:codex').id).toBe(first.id);
 clients.revoke(first.id);expect(()=>clients.ensure('Codex runner','codex','runner:codex')).toThrow('revoked');expect(clients.list()).toHaveLength(1);
 const next=clients.reconnect(first.id);expect(next.id).not.toBe(first.id);expect(clients.ensure('Codex runner','codex','runner:codex').id).toBe(next.id);expect(clients.list()).toHaveLength(2);
});

test('legacy replacement only retires the plugin after authenticated use, and retries are stable',()=>{
 const {root,clients}=fixture();
 const old=clients.create({name:'Codex plugin',kind:'codex',managedBy:'codex-plugin'});
 const next=clients.replace(old.id);
 expect(clients.replace(old.id).id).toBe(next.id);
 expect(clients.list().find(c=>c.id===old.id)?.revoked).toBeNull();
 expect(clients.list().find(c=>c.id===next.id)?.lastUsed).toBeNull();
 expect(()=>authenticateClient(root,clients.token(next.id),'admin',clients.store)).toThrow();
 expect(clients.list().find(c=>c.id===old.id)?.revoked).toBeNull();
 authenticateClient(root,clients.token(next.id),'vault:read',clients.store);
 expect(clients.list().find(c=>c.id===old.id)?.revoked).toBeTruthy();
 expect(clients.list().find(c=>c.id===next.id)?.lastUsed).toBeTruthy();
 expect(clients.list().find(c=>c.id===next.id)?.managedBy).toBeUndefined();
 expect(()=>clients.ensure('Codex plugin','codex','codex-plugin')).toThrow('revoked');
});
test('canceling a pending replacement leaves the plugin working',()=>{
 const {clients}=fixture();const old=clients.create({name:'Claude plugin',kind:'claude-code',managedBy:'claude-plugin'});
 const next=clients.replace(old.id);clients.revoke(next.id);
 expect(clients.token(old.id)).toStartWith('bb_');expect(clients.replace(old.id).id).not.toBe(next.id);
});

test('legacy plugins cannot provision new connections',()=>{
 const {clients}=fixture();
 expect(()=>clients.ensure('Claude plugin','claude-code','claude-plugin')).toThrow('deprecated');
 expect(()=>clients.ensure('Codex plugin','codex','codex-plugin')).toThrow('deprecated');
 expect(clients.list()).toHaveLength(0);
});

test('MCP handshake alone confirms a replacement and retires its legacy connection',async()=>{
 const {root,clients}=fixture();
 const old=clients.create({name:'Old plugin',kind:'codex',managedBy:'codex-plugin'});
 const setup=clients.replace(old.id), client=new Client({name:'Handshake only',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('bin/mcp.ts'),'--client',setup.id],env:{PATH:process.env.PATH!,HOME:process.env.HOME!,BIGBRAIN_VAULT:root,BIGBRAIN_TOKENS:clients.store},stderr:'pipe'});
 try {
  await client.connect(transport);
  // Ping follows initialized on the same transport without discovering/calling tools.
  await client.ping();
  expect(clients.list().find(c=>c.id===setup.id)?.lastUsed).toBeTruthy();
  expect(clients.list().find(c=>c.id===old.id)?.revoked).toBeTruthy();
 } finally { await client.close(); }
});
