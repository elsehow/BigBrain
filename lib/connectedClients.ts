/** MCP connections are credentials/configurations, not agent runners or devices. */
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { listTokens, mintToken, revokeToken, renewToken, tokenStorePath, verifyToken, touchLastUsed, hasScope, tokenExpired, noteExpiredUse, clearExpiredUse, expiredMessage, listedInConnectedClients } from "./auth";
import { writeAtomic } from "./fsx";
import { mcpServerEntry } from "./mcpRegister";
import { apiPort } from "./env";
import { DOOR_SENTENCE } from "./doorPresentation";
/** The one door: MCP over the local API. */
export const doorUrl=(port=apiPort())=>`http://127.0.0.1:${port}/mcp`;
const quote=(s:string)=>/^[a-zA-Z0-9_@%+=:,./-]+$/.test(s)?s:"'"+s.replaceAll("'", "'\\''")+"'";
export const CLIENT_KINDS = ["claude-code", "codex", "generic"] as const;
export type ClientKind = typeof CLIENT_KINDS[number];
interface Credential { id: string; kind: ClientKind; token: string; managedBy?: string; replaces?: string }
const legacyPlugin = (manager?: string) => manager === "claude-plugin" || manager === "codex-plugin";
/** A lapsed connection: its holder is told how to renew, and the app shows a notice. */
export class ConnectionExpired extends Error {}
export class ConnectedClients {
  readonly store: string;
  constructor(readonly root: string, store?: string) { this.store = store ?? tokenStorePath(root); }
  private directory(): string { return this.store + ".clients"; }
  private path(id: string): string { if (!/^[a-f0-9]{8}$/.test(id)) throw new Error("Invalid client connection."); return join(this.directory(), id + ".json"); }
  private credential(id: string): Credential {
    try { return JSON.parse(readFileSync(this.path(id), "utf8")); }
    catch { throw new Error("Client credential is unavailable. Reconnect in Connected Clients."); }
  }
  list() {
    return listTokens(this.store).filter(listedInConnectedClients).map(t => {
      let kind: ClientKind = "generic", managedBy: string | undefined, replaces: string | undefined;
      // The legacy local Claude Code (`bigbrain connect` before named connections) kept no credential here; its name says which agent.
      if (t.via === "connect") kind = t.name.startsWith("codex") ? "codex" : "claude-code";
      else try { const c = this.credential(t.id); kind = c.kind; managedBy = c.managedBy; replaces = c.replaces; } catch { /* Public history survives a lost local credential. */ }
      const expired=!t.revoked&&tokenExpired(t);
      return { id:t.id, name:t.name, kind, managedBy, legacy:t.via === "connect" || legacyPlugin(managedBy), replaces, created:t.created, lastUsed:t.last_used, revoked:t.revoked,
        expired, expiredUse:expired ? t.expired_use ?? null : null, vault:{read:hasScope(t,"vault:read"),contribute:hasScope(t,"inbox:write")} };
    });
  }
  create(value: {name?:unknown;kind?:unknown;managedBy?:string;replaces?:string}) {
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 120) throw new Error("Name this client connection (up to 120 characters).");
    if (!CLIENT_KINDS.includes(value.kind as ClientKind)) throw new Error("Choose Claude Code, Codex, or generic MCP.");
    const {record,token} = mintToken(this.store,this.root,value.name.trim(),["vault:read","inbox:write"],{kind:"agent",via:"client"});
    const path=this.path(record.id);mkdirSync(dirname(path),{recursive:true,mode:0o700});
    try { writeAtomic(path,JSON.stringify({id:record.id,kind:value.kind,token,...(value.replaces ? {replaces:value.replaces}: {}),...(value.managedBy ? {managedBy:value.managedBy}: {})})+"\n",0o600); }
    catch(e) { revokeToken(this.store,record.id);throw e; }
    return this.setup(record.id);
  }
  /** Stable local configuration identity. Revocation never silently creates a replacement. */
  ensure(name:string,kind:ClientKind,managedBy:string) {
    const matches=this.list().filter(c=>c.managedBy===managedBy);
    const existing=matches.find(c=>!c.revoked) ?? matches[0];
    if(!existing&&legacyPlugin(managedBy))throw new Error("Plugin connections are deprecated. Add a named MCP connection in Settings → Connected Clients.");
    return existing ? this.setup(existing.id) : this.create({name,kind,managedBy});
  }
  /** A lapsed connection still has its credential: presenting it is what names the fix. */
  token(id:string): string {
    const c=this.credential(id), verified=verifyToken(this.store,c.token);
    if ((verified.ok ? verified.record : verified.expired)?.id !== id) throw new Error("Client connection was revoked. Reconnect in Connected Clients.");
    return c.token;
  }
  /** How an agent reaches the vault through the one door (#302): the local
   * API's `/mcp`, with this connection's credential in the header. It holds
   * the secret, so it is shown only when asked for, and only in the app. */
  setup(id:string) {
    const token=this.token(id), c=this.credential(id), url=doorUrl(), bearer=`Bearer ${token}`;
    const claude=`claude mcp remove --scope user bigbrain\nclaude mcp add --scope user --transport http bigbrain ${url} --header ${quote("Authorization: "+bearer)}`;
    // The Codex CLI takes a bearer token only from an environment variable; its config file takes the header itself.
    const codex=`[mcp_servers.bigbrain]\nurl = "${url}"\nhttp_headers = { Authorization = "${bearer}" }`;
    const after=" BigBrain has to be running for the agent to reach the vault. This setup holds the connection’s secret: give it only to that agent.";
    return {id,kind:c.kind,url,sentence:DOOR_SENTENCE,configuration:{mcpServers:{bigbrain:{type:"http",url,headers:{Authorization:bearer}}}},
      command:c.kind==="claude-code" ? claude : c.kind==="codex" ? codex : null,claude,codex,
      instructions:(c.kind==="claude-code" ? "Run this in a terminal, then restart Claude Code. It replaces your user-level bigbrain entry; a missing-entry message from the first line is harmless."
        : c.kind==="codex" ? "Add this to ~/.codex/config.toml in place of any [mcp_servers.bigbrain] there, then restart Codex."
        : "Add this configuration in your MCP client, then restart that client.")+after};
  }
  /** The stdio server's entry for this connection: for clients that launch
   * a process (`bigbrain mcp config`, `register`, Codex set up from the app)
   * until the door replaces it. No secret: the process reads the credential. */
  stdio(id:string) {
    this.token(id);
    const entry=mcpServerEntry(this.root);entry.args=[...(entry.args ?? []),"--client",id];
    return {mcpServers:{bigbrain:entry}};
  }
  /** Keep the old plugin authorized until its named replacement actually authenticates. */
  replace(id:string) {
    const old=this.list().find(c=>c.id===id);
    if(!old?.legacy)throw new Error("Choose a legacy plugin connection to replace.");
    const pending=this.list().find(c=>c.replaces===id&&!c.revoked);
    return pending ? this.setup(pending.id) : this.create({name:old.kind==="codex"?"Codex":"Claude Code",kind:old.kind,replaces:id});
  }
  observed(id:string) {
    const current=this.list().find(c=>c.id===id);
    if(!current?.replaces)return;
    const old=this.list().find(c=>c.id===current.replaces);
    if(old?.legacy&&!old.revoked)this.revoke(old.id);
  }
  reconnect(id:string) {
    const old=this.list().find(c=>c.id===id);if(!old)throw new Error('Client connection not found.');
    if(old.legacy)return this.replace(id);
    if(!old.revoked)this.revoke(id);
    return this.create({name:old.name,kind:old.kind,managedBy:old.managedBy,replaces:old.replaces});
  }
  /** Same id, same grants: unlike reconnect(), nothing is re-minted. */
  renew(id:string): void {
    if(!this.list().some(c=>c.id===id))throw new Error("Client connection not found.");
    if(!renewToken(this.store,id))throw new Error("Client connection was revoked. Reconnect in Connected Clients.");
  }
  dismiss(id:string): void {
    if (!this.list().some(c=>c.id===id) || !clearExpiredUse(this.store,id)) throw new Error("Client connection not found.");
  }
  revoke(id:string): void {
    if (!this.list().some(c=>c.id===id) || !revokeToken(this.store,id)) throw new Error("Client connection not found.");
  }
}
/** Every external call is authenticated, including vault reads and contribution. */
export function authenticateClient(root:string,token:string|undefined,scope:string,store=tokenStorePath(root)) {
  const result=verifyToken(store,token ?? "");
  if (!result.ok && result.expired) { noteExpiredUse(store,result.expired.id);throw new ConnectionExpired(expiredMessage(result.expired)); }
  if (!result.ok || !hasScope(result.record,scope)) throw new Error("Authenticate a current client connection with the required access in Connected Clients.");
  touchLastUsed(store,result.record.id);
  new ConnectedClients(root,store).observed(result.record.id);
  return result.record;
}
