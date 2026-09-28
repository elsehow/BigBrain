import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ImapFlow } from "imapflow";
import { gitVault } from "./support/vault";
import { configSave, integrationsInfo } from "../lib/configWrite";
import { deactivateIntegration, integrationActive } from "../lib/integrationAccess";
import { integrationToolCall } from "../lib/integrationTools";
import { pilotToolCall, pilotTools } from "../lib/pilot";
import { handleMcpTool, mcpToolList, type McpContext } from "../lib/mcp";
import { mintToken, revokeToken } from "../lib/auth";
import { loadManifest } from "../lib/manifest";
import { readSourceInsertionLog } from "../lib/insertionLog";
import { stage, stagedHeads, admitStaged, passStaged } from "../lib/stage";
import { nextWork } from "../lib/work";
const roots: string[] = [];
const originalStore = process.env.BIGBRAIN_TOKENS;
afterEach(() => { if(originalStore === undefined) delete process.env.BIGBRAIN_TOKENS; else process.env.BIGBRAIN_TOKENS=originalStore; for(const r of roots.splice(0)) rmSync(r,{recursive:true,force:true}); });
function fixture() {
 const root=gitVault({files:{"vault.yaml":"integrations:\n  email:\n    enabled: false\n    inboxes:\n      - address: me@example.com\n        host: imap.example.com\n      - address: work@example.com\n        host: imap.example.com\n", ".env":"BIGBRAIN_IMAP_PASSWORD__ME_EXAMPLE_COM=synthetic\nBIGBRAIN_IMAP_PASSWORD__WORK_EXAMPLE_COM=synthetic-work\n"}});
 roots.push(root); const store=join(root,"tokens.json"); process.env.BIGBRAIN_TOKENS=store;
 const credential=mintToken(store,root,"Test external agent",["vault:read","inbox:write"],{kind:"agent"});
 const grants=[{caller:"pilot",accounts:["me@example.com"]},{caller:"token:"+credential.record.id,accounts:["me@example.com"]}];
 const op={name:"email",enabled:true,activate:true,remember:"Remember project decisions; skip promotions and material before 2026.",readers:grants};
 const save=(value:unknown,probe=async()=>{})=>configSave(root,JSON.stringify({integrations:[value]}),probe);
 return {root,store,credential,grants,op,save};
}
function provider(onConnect?:()=>Promise<void>) {
 let calls=0,closes=0;
 const client=()=>({on(){},connect:async()=>{calls++;await onConnect?.();},close(){closes++;},mailbox:{exists:1,uidValidity:77n},capabilities:new Set(),
 getMailboxLock:async(_p:unknown,o:any)=>{expect(o.readOnly).toBe(true);return {release(){}};},search:async()=>[1],
 fetchAll:async()=>[{uid:1,envelope:{subject:"Project Atlas"},flags:new Set(),size:50}],
 fetchOne:async()=>({uid:1,envelope:{subject:"Project Atlas"},flags:new Set(),size:50,source:Buffer.from("Subject: Project Atlas\r\n\r\nWe chose the smaller design.")}),
 }) as unknown as ImapFlow;
 return {client,calls:()=>calls,closes:()=>closes};
}
test("activation is explicit, verified, rule-bound; failed/canceled setup remains inactive",async()=>{
 const f=fixture(),before=readFileSync(join(f.root,"vault.yaml"),"utf8");let probes=0;
 const probe=async()=>{probes++;};
 expect((await f.save({name:"email",checkAccess:true},probe)).status).toBe(200);
 expect(probes).toBe(2);expect(integrationActive(f.root,"email")).toBe(false);
 expect(readFileSync(join(f.root,"vault.yaml"),"utf8")).toBe(before);
 for(const op of [{name:"email",enabled:true},{...f.op,remember:" "},{...f.op,readers:[{caller:"pilot",accounts:["other@example.com"]}]}])expect((await f.save(op,probe)).status).toBe(400);
 expect((await f.save(f.op,async()=>{throw Error("bad credentials");})).status).toBe(400);
 expect(integrationActive(f.root,"email")).toBe(false);expect(readFileSync(join(f.root,"vault.yaml"),"utf8")).toBe(before);
 expect(await f.save(f.op,probe)).toMatchObject({status:200});expect(integrationActive(f.root,"email")).toBe(true);
 const info=integrationsInfo(f.root,loadManifest(f.root));expect(JSON.stringify(info)).not.toContain("synthetic-work");
 expect((await f.save({name:"email",enabled:false})).status).toBe(200);expect(integrationActive(f.root,"email")).toBe(false);
 expect(loadManifest(f.root).integrations.email?.remember).toBe(f.op.remember);
 expect((await f.save(f.op,async()=>{throw Error("revoked");})).status).toBe(400);expect(integrationActive(f.root,"email")).toBe(false);
});
test("Pilot and authenticated MCP use the same account-scoped reads without remembering",async()=>{
 const f=fixture();expect(await f.save(f.op)).toMatchObject({status:200});const p=provider();
 const ctx:McpContext={root:f.root,via:"cli",clientName:"untrusted name",integrationToken:f.credential.token,tokenStore:f.store,integrationOptions:p};
 const pilot:any=await pilotToolCall(f.root,"inbox_list",{},p);
 const external:any=await handleMcpTool(ctx,"inbox_list",{});
 await expect(integrationToolCall(f.root,{kind:"gardener"},"inbox_list",{},p)).rejects.toThrow("landed arrivals");
 expect(pilot.result.messages).toEqual(external.result.messages);
 expect(pilot.provenance).toMatchObject({account:"me@example.com",remembered:false,scope:"live_source"});
 const body:any=await handleMcpTool(ctx,"inbox_read",{ref:external.result.messages[0].ref});expect(body.result.selected.body).toContain("smaller design");
 expect(readSourceInsertionLog(f.root)).toHaveLength(0);expect(stagedHeads(f.root)).toHaveLength(0);
 const count=p.calls();
 for(const actor of [{kind:"pilot" as const},{kind:"mcp" as const,token:f.credential.token,storePath:f.store}]) {
  await expect(integrationToolCall(f.root,actor,"inbox_list",{account:"work@example.com"},p)).rejects.toThrow("not available");
  const ref=Buffer.from(JSON.stringify({account:"work@example.com",uid:1,validity:"77"})).toString("base64url");
  await expect(integrationToolCall(f.root,actor,"inbox_read",{ref},p)).rejects.toThrow("not available");
 }
 await expect(handleMcpTool({...ctx,integrationToken:undefined,clientName:"pilot"},"inbox_list",{caller:"pilot"})).rejects.toThrow("Authenticate");
 expect(p.calls()).toBe(count);
 expect(pilotTools().map(t=>t.name)).not.toContain("set_source_unread");
 await expect(pilotToolCall(f.root,"set_source_unread",{paths:[],unread:false})).rejects.toThrow("no such tool");
 // Only an explicit contribution creates an arrival; curation still belongs to the gardener.
 await handleMcpTool(ctx,"drop",{title:"Atlas decision",body:body.result.selected.body});
 expect(readSourceInsertionLog(f.root)).toHaveLength(1);
});
test("revocation and account changes affect existing sessions; in-flight results are withheld",async()=>{
 const f=fixture();await f.save(f.op);const p=provider();
 const ctx:McpContext={root:f.root,via:"cli",integrationToken:f.credential.token,tokenStore:f.store,integrationOptions:p};
 expect(mcpToolList(ctx).some(t=>t.name==="inbox_list")).toBe(true);
 revokeToken(f.store,f.credential.record.id);
 expect(mcpToolList(ctx).some(t=>t.name==="inbox_list")).toBe(false);
 await expect(handleMcpTool(ctx,"inbox_list",{})).rejects.toThrow("Authenticate");expect(p.calls()).toBe(0);
 const slow=provider(async()=>{deactivateIntegration(f.root,"email");});
 await expect(pilotToolCall(f.root,"inbox_list",{},slow)).rejects.toThrow();expect(slow.closes()).toBeGreaterThan(0);
 await f.save({...f.op,readers:f.grants.filter(g=>!g.caller.startsWith("token:"))});
 writeFileSync(join(f.root,".env"),"BIGBRAIN_IMAP_PASSWORD__ME_EXAMPLE_COM=replacement\n");
 await expect(pilotToolCall(f.root,"inbox_list",{},p)).rejects.toThrow("not available");expect(p.calls()).toBe(0);
});
test("deactivation racing an access check cannot be undone by its late result",async()=>{
 const f=fixture();await f.save(f.op);
 const result=await f.save(f.op,async()=>{deactivateIntegration(f.root,"email");});
 expect(result.status).toBe(400);expect(integrationActive(f.root,"email")).toBe(false);
});
test("remembering rules reach the gardener; disabled pending data survives and cannot be admitted or passed",async()=>{
 const f=fixture();await f.save(f.op);
 stage(f.root,{id:"mail",source:"email",account:"me@example.com",at:"2026-09-23",line:"Atlas decision",scopes:{},name:"atlas.md",content:"---\nid: atlas-decision\nsource: email\n---\nWe chose the smaller design."});
 const next=nextWork(f.root,{kinds:["staged"]});expect(next[0]?.inputs).toMatchObject({remembering_rule:f.op.remember});
 await f.save({name:"email",enabled:false});expect(stagedHeads(f.root)).toHaveLength(0);
 expect(admitStaged(f.root,["mail"])[0]?.ok).toBe(false);expect(passStaged(f.root,["mail"],"not now")[0]?.ok).toBe(false);
 expect(readSourceInsertionLog(f.root)).toHaveLength(0);
 await f.save(f.op);expect(stagedHeads(f.root)).toHaveLength(1);
 expect(admitStaged(f.root,["mail"])[0]?.ok).toBe(true);expect(readSourceInsertionLog(f.root)).toHaveLength(1);
});
test("the actual MCP transport authenticates integrations by token, never client name",async()=>{
 const f=fixture();await f.save(f.op);
 const client=new Client({name:"pilot",version:"1"});
 try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve("bin/mcp.ts")],env:{...process.env,BIGBRAIN_VAULT:f.root,BIGBRAIN_TOKENS:f.store,BIGBRAIN_MCP_TOKEN:f.credential.token} as Record<string,string>,stderr:"pipe"}));
  expect((await client.listTools()).tools.some(t=>t.name==="inbox_list")).toBe(true);
  const result:any=await client.callTool({name:"integration_capabilities",arguments:{}});expect(JSON.parse(result.content[0].text).email.accounts).toEqual(["me@example.com"]);
  revokeToken(f.store,f.credential.record.id);
  expect((await client.callTool({name:"inbox_list",arguments:{}})).isError).toBe(true);
  await expect(client.listTools()).rejects.toThrow("Authenticate");
 } finally {await client.close();}
});

test("staged That Tracks revisions link at admission and cannot resurrect an older revision", async () => {
 const { fakeIntegrationActivation } = await import("./support/integrationActivation");
 const { stageIntegrationContent } = await import("../lib/integrationStage");
 const { serializeEnvelope } = await import("../lib/envelope");
 const { stagedHeads, openStaged } = await import("../lib/stage");
 const { readSourceInsertionLog } = await import("../lib/insertionLog");
 const f=fixture();fakeIntegrationActivation(f.root,"that-tracks");
 const content=(seq:number)=>serializeEnvelope({id:"that-tracks-account-event",source:"that-tracks",stream:"that-tracks:account",seq,title:"Tracked event"},`Revision ${seq}`);
 for(const seq of [1,2,3])stageIntegrationContent(f.root,"that-tracks",content(seq));
 const pending=stagedHeads(f.root);expect(pending).toHaveLength(3);
 const ids=[1,2,3].map(seq=>pending.find(h=>openStaged(f.root,[h.id]).some((v:any)=>v.content?.includes(`Revision ${seq}`)))!.id);
 const first=admitStaged(f.root,[ids[0]!])[0]!;expect(first.ok).toBe(true);
 const last=admitStaged(f.root,[ids[2]!])[0]!;expect(last.ok).toBe(true);
 expect(readSourceInsertionLog(f.root).find(e=>e.id===last.insertion_id)?.envelope.supersedes).toBe(first.insertion_id);
 expect(admitStaged(f.root,[ids[1]!])[0]!.ok).toBe(false);
});
test('live write grants change only the selected Seen flag and never remember mail',async()=>{
 const {IntegrationAccounts}=await import('../lib/integrationAccounts');
 const f=fixture();await f.save(f.op);const accounts=new IntegrationAccounts(f.root);
 const ref=Buffer.from(JSON.stringify({account:'me@example.com',uid:1,validity:'77'})).toString('base64url');
 const flags=new Set<string>(),changes:any[]=[];let connects=0;
 const client=()=>({on(){},connect:async()=>{connects++;},close(){},mailbox:{exists:1,uidValidity:77n,readOnly:false},
 getMailboxLock:async(_p:string,o:any)=>{expect(o.readOnly).toBe(false);return {release(){}};},
 fetchOne:async()=>({uid:1,flags,envelope:{subject:'Decision'}}),
 messageFlagsAdd:async(ids:any,values:any,o:any)=>{changes.push({ids,values,o});flags.add('\\Seen');return true;},
 messageFlagsRemove:async(ids:any,values:any,o:any)=>{changes.push({ids,values,o});flags.delete('\\Seen');return true;},
 }) as unknown as ImapFlow;
 await expect(integrationToolCall(f.root,{kind:'pilot'},'inbox_set_unread',{ref,unread:false},{client})).rejects.toThrow('write access');expect(connects).toBe(0);
 await accounts.update({name:'email',account:'me@example.com',action:'grant',caller:'pilot',access:'read-write'});
 expect(await integrationToolCall(f.root,{kind:'pilot'},'inbox_set_unread',{ref,unread:false},{client})).toMatchObject({result:{unread:false,remembered:false}});
 await integrationToolCall(f.root,{kind:'pilot'},'inbox_set_unread',{ref,unread:true},{client});
 expect(changes).toEqual([{ids:[1],values:['\\Seen'],o:{uid:true}},{ids:[1],values:['\\Seen'],o:{uid:true}}]);expect(flags.size).toBe(0);expect(readSourceInsertionLog(f.root)).toHaveLength(0);expect(stagedHeads(f.root)).toHaveLength(0);
 const wrong=Buffer.from(JSON.stringify({account:'work@example.com',uid:1,validity:'77'})).toString('base64url');
 await expect(integrationToolCall(f.root,{kind:'pilot'},'inbox_set_unread',{ref:wrong,unread:false},{client})).rejects.toThrow('write access');expect(connects).toBe(2);
 await accounts.update({name:'email',account:'me@example.com',action:'grant',caller:'pilot',access:'off'});
 await expect(integrationToolCall(f.root,{kind:'pilot'},'inbox_set_unread',{ref,unread:false},{client})).rejects.toThrow('write access');expect(connects).toBe(2);
});
