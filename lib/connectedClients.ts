/** MCP connections are credentials/configurations, not agent runners or devices. */
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { listTokens, mintToken, revokeToken, renewToken, tokenStorePath, verifyToken, touchLastUsed, hasScope, tokenExpired, noteExpiredUse, clearExpiredUse, expiredMessage, listedInConnectedClients } from "./auth";
import { writeAtomic } from "./fsx";
import { mcpServerEntry } from "./mcpRegister";
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
  setup(id:string) {
    this.token(id);
    const c=this.credential(id), entry=mcpServerEntry(this.root);
    entry.args=[...(entry.args ?? []),"--client",id];
    const quote=(s:string)=>/^[a-zA-Z0-9_@%+=:,./-]+$/.test(s)?s:"'"+s.replaceAll("'", "'\\''")+"'";
    const envArgs=Object.entries(entry.env ?? {}).flatMap(([k,v])=>["--env",`${k}=${v}`]);
    const argv=c.kind==="claude-code" ? ["claude","mcp","add","--scope","user",...envArgs,"--transport","stdio","bigbrain","--",entry.command,...entry.args]
      : c.kind==="codex" ? ["codex","mcp","add","bigbrain",...envArgs,"--",entry.command,...entry.args] : null;
    return {id,kind:c.kind,configuration:{mcpServers:{bigbrain:entry}},command:argv ? (c.kind==="claude-code" ? "claude mcp remove --scope user bigbrain\n" : "") + argv.map(quote).join(" ") : null,
      instructions:(c.kind==="generic" ? "Add this configuration in your MCP client, then restart that client." : `Run the setup in a terminal, then restart ${c.kind==="codex" ? "Codex" : "Claude Code"} (restarting BigBrain is not enough).`) + (c.kind==="claude-code" ? " This replaces the existing user-level bigbrain entry; a missing-entry message on the first command is harmless." : "") + " No secret is embedded; this setup works on this computer."};
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
