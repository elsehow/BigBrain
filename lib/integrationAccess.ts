/** Account access owned by BigBrain, independent of native agent permissions. */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadManifest, integrationEnabledIn } from "./manifest";
import { readEnvValues } from "./envFile";
import { writeAtomic } from "./fsx";
import { listTokens, tokenStorePath, verifyToken, hasScope } from "./auth";
import { integrationNamed, type Integration } from "./integrations";
import { extraAccounts, policyPath } from "./integrations/contract";
import { hasAccountPolicy } from "./integrationLibrary";

export { MANAGED_INTEGRATIONS } from "./integrations";
export { extraAccounts } from "./integrations/contract";
export interface IntegrationGrant { caller: string; accounts: string[] }
export interface IntegrationActivation {
  version: 1; active: boolean; fingerprint: string; checkedAt: string; grants: IntegrationGrant[];
}
export type IntegrationCaller = { kind: "worker"; accounts: { integration: string; account: string }[] } | { kind: "pilot" | "gardener" } | { kind: "mcp"; token?: string; storePath?: string };
const managed = (name: string): Integration => {
  const integration = integrationNamed(name);
  if (!integration) throw new Error("This integration has no activation adapter.");
  return integration;
};
const file = (root: string, name: string) => { managed(name); return join(root, ".spool", "integration-access", name + ".json"); };
export function activationRecord(root: string, name: string): IntegrationActivation | undefined {
  try {
    const v = JSON.parse(readFileSync(file(root, name), "utf8"));
    if (v.version !== 1 || typeof v.active !== "boolean" || typeof v.fingerprint !== "string" || typeof v.checkedAt !== "string" || !Array.isArray(v.grants)) return;
    if (v.grants.some((g: any) => typeof g.caller !== "string" || !Array.isArray(g.accounts) || g.accounts.some((a: unknown) => typeof a !== "string"))) return;
    return v;
  } catch { return; }
}
export function integrationAccounts(root: string, name: string): string[] {
  return integrationNamed(name)?.accounts(root) ?? [name,...extraAccounts(root,name).map(a=>a.id)];
}
/** Credentials never leave the host. Changing account settings invalidates the check. */
export function integrationFingerprint(root: string, name: string): string {
  const cfg = loadManifest(root).integrations[name] ?? {};
  const { enabled: _e, remember: _r, skip: _s, ...connection } = cfg;
  const env = readEnvValues(root), { credential } = managed(name), accounts = integrationAccounts(root, name);
  // a legacy activation covered an integration's built-in account, or every account of one without
  const keys = credential.envKey ? (accounts.includes(name) ? [name] : accounts).map(credential.envKey) : [];
  return createHash("sha256").update(JSON.stringify([connection, keys.map(k => env[k] ?? "")])).digest("hex");
}
export function integrationActive(root: string, name: string, account?: string): boolean {
  if (!integrationNamed(name)) return integrationEnabledIn(loadManifest(root).integrations,name);
  return (account ? [account] : integrationAccounts(root,name)).some(a => {
    return accountPolicy(root,name,a).connected; // a connected account is always remembered
  });
}
export function integrationCallerChoices(root: string) {
  return [{ id: "pilot", label: "Pilot" },
    ...listTokens(tokenStorePath(root)).filter(t => !t.revoked && hasScope(t, "vault:read"))
      .map(t => ({ id: "token:" + t.id, label: t.name }))];
}
/** Activation connects every account. Who reads each is chosen per account in Settings, never here: an account keeps its grants. */
export function saveIntegrationActivation(root: string, name: string, fingerprint: string): void {
  if (fingerprint !== integrationFingerprint(root, name)) throw new Error("Account settings changed during the access check. Try again.");
  // read before the record below is written: an account with no policy yet falls back to the older record
  const policies = integrationAccounts(root,name).map(account => ({account,policy:connectedPolicy(name,accountPolicy(root,name,account),accountFingerprint(root,name,account),!hasAccountPolicy(root,name,account))}));
  const record: IntegrationActivation = { version: 1, active: true, fingerprint, checkedAt: new Date().toISOString(), grants: [] };
  writeAtomic(file(root, name), JSON.stringify(record) + "\n", 0o600);
  for (const {account,policy} of policies) writeAccountPolicy(root,name,account,policy);
}
export function deactivateIntegration(root: string, name: string): void {
  const policies = integrationAccounts(root,name).map(account => ({account,policy:accountPolicy(root,name,account)}));
  const prior = activationRecord(root, name);
  for (const {account,policy} of policies) writeAccountPolicy(root,name,account,{...policy,connected:false});
  writeAtomic(file(root, name), JSON.stringify({ version:1, fingerprint:"", checkedAt:new Date().toISOString(), grants:[], ...prior, active: false }) + "\n", 0o600);
}
/** Who is asking, as grants name them: `pilot`, `token:<id>`, `worker`. Throws for a caller that may not read live accounts at all. */
export function integrationCallerId(root: string, caller: IntegrationCaller): string {
  if (caller.kind === "gardener") throw new Error("Gardener reads landed arrivals only; live accounts are unavailable.");
  if (caller.kind !== "mcp") return caller.kind;
  const result = verifyToken(caller.storePath ?? tokenStorePath(root), caller.token ?? "");
  if (!result.ok || !hasScope(result.record, "vault:read")) throw new Error("Authenticate this MCP client with a current vault-read credential.");
  return "token:" + result.record.id;
}
export function readableIntegrationAccounts(root: string, name: string, caller: IntegrationCaller): string[] {
  if (caller.kind === "worker") return readableIntegrationAccounts(root, name, {kind: "pilot"}).filter(a => caller.accounts.some(g => g.integration === name && g.account === a));
  const id = integrationCallerId(root, caller);
  return integrationAccounts(root,name).filter(a => { const p=accountPolicy(root,name,a);return p.connected && accessOf(p,id)!=="off"; });
}
export function requireIntegrationRead(root: string, name: string, account: string, caller: IntegrationCaller): void {
  if (!readableIntegrationAccounts(root, name, caller).includes(account))
    throw new Error("This account is not available to this caller. Update access in Settings → Integrations.");
}

/** "Import earlier …" in Settings: a poller honors each request once. */
export interface Backfill { since: string; request: string }
export type LiveAccess = "off" | "read" | "read-write";
/** Who a grant names: Pilot, or one connected client by its token id. `desktop:<id>` is reserved for coding desktops and issued by nothing yet. */
export type GrantCaller = "pilot" | `token:${string}` | `desktop:${string}`;
export interface AccountGrant { caller: GrantCaller; access: LiveAccess }
export interface AccountPolicy {
  version:3; connected:boolean; fingerprint:string; checkedAt:string|null;
  email?: { startAt: string; attachments: boolean; backfill?: Backfill };
  granola?: { backfill?: Backfill };
  /** The only source of live access: a caller without a grant reads nothing. */
  grants:AccountGrant[];
}
const ACCESS:LiveAccess[]=["off","read","read-write"];
const isGrantCaller=(c:unknown):c is GrantCaller=>typeof c==="string"&&/^(?:pilot|(?:token|desktop):\S+)$/.test(c);
const accessOf=(p:AccountPolicy,id:string):LiveAccess=>p.grants.find(g=>g.caller===id)?.access??"off";
/** Pilot reads, where the integration has live tools; nothing else. */
const pilotReads=(name:string):AccountGrant[]=>integrationNamed(name)?.tools.length?[{caller:"pilot",access:"read"}]:[];
/** A newly connected account: Pilot reads; every client starts off. */
export const defaultGrants=(name:string):AccountGrant[]=>pilotReads(name);
/** Connected now. Only an account connecting for the first time (`fresh`: no policy file before this change began, and never
 * checked) starts at the defaults. Any other keeps its grants, so a choice an older engine recorded is never widened. */
export function connectedPolicy(name:string,policy:AccountPolicy,fingerprint:string,fresh:boolean):AccountPolicy{
  return {...policy,...(fresh&&policy.checkedAt===null?{grants:defaultGrants(name)}:{}),connected:true,fingerprint,checkedAt:new Date().toISOString()};
}
const accountPolicyFile = (root:string,name:string,account:string):string => { managed(name); return policyPath(root,name,account); };
export function accountFingerprint(root:string,name:string,account:string):string {
  if (!integrationAccounts(root,name).includes(account)) throw new Error("Choose a configured account.");
  return managed(name).fingerprint(root,account);
}
export function accountPolicy(root:string,name:string,account:string):AccountPolicy {
  const empty:AccountPolicy={version:3,connected:false,fingerprint:"",checkedAt:null,grants:[]};
  if(!integrationAccounts(root,name).includes(account))return empty;
  let raw:string;
  try{raw=readFileSync(accountPolicyFile(root,name,account),"utf8");}
  catch(e){
    if((e as NodeJS.ErrnoException).code!=="ENOENT")return empty;
    // Tolerant read of explicit prior activation; never infer consent from credentials.
    if(integrationNamed(name)?.credential.kind==="oauth"||(name!=="email"&&account!==name))return empty;
    const old=activationRecord(root,name);
    const valid=!!old?.active && integrationEnabledIn(loadManifest(root).integrations,name) && old.fingerprint===integrationFingerprint(root,name);
    // the access reset applies here too: Pilot keeps read if it held it, and no client carries over
    return {...empty,connected:valid,fingerprint:valid?accountFingerprint(root,name,account):"",checkedAt:old?.checkedAt??null,
      grants:(old?.grants??[]).some(g=>g.caller==="pilot"&&g.accounts.includes(account))?pilotReads(name):[]};
  }
  try {
    const p=JSON.parse(raw);
    // An unknown version is a newer engine's: fail closed rather than guess.
    if((p.version!==2&&p.version!==3)||typeof p.connected!=="boolean"||typeof p.fingerprint!=="string"||!Array.isArray(p.grants)||p.grants.some((g:any)=>typeof g?.caller!=="string"||!ACCESS.includes(g.access)))return empty;
    if(p.version===2&&p.liveAccess!==undefined&&typeof p.liveAccess!=="boolean")return empty;
    if(p.version===3&&!p.grants.every((g:any)=>isGrantCaller(g.caller)))return empty;
    // Version 2 is read as 3 and written as 3 on the next change: the access reset. Its `liveAccess` overrode
    // every caller's grant; now grants alone decide. Pilot keeps read where it could read, never read-write, and
    // every client starts off. Connection, settings and credentials stay as they were.
    const grants:AccountGrant[]=p.version===3?p.grants:(p.liveAccess??accessOf(p,"pilot")!=="off")?pilotReads(name):[];
    // a retired `remembering` switch or rule in an older file is ignored: a connected account is remembered
    const {remembering:_retired,liveAccess:_override,...policy}=p;
    return {...policy,version:3,grants,connected:p.connected&&(managed(name).credential.signedIn?.(root,account)??true)&&p.fingerprint===accountFingerprint(root,name,account)};
  }catch{return empty;}
}
export function writeAccountPolicy(root:string,name:string,account:string,policy:AccountPolicy):void {
  if(!integrationAccounts(root,name).includes(account))throw new Error("Choose a configured account.");
  writeAtomic(accountPolicyFile(root,name,account),JSON.stringify(policy)+"\n",0o600);
  writeAtomic(join(root,".spool","integration-account-revision"),crypto.randomUUID(),0o600);
}
/** A removed account leaves no choices behind for a re-added one to inherit. */
export function removeAccountPolicy(root:string,name:string,account:string):void {
  rmSync(accountPolicyFile(root,name,account),{force:true});
  writeAtomic(join(root,".spool","integration-account-revision"),crypto.randomUUID(),0o600);
}
export function integrationConnected(root:string,name:string,account?:string):boolean {
  return (account?[account]:integrationAccounts(root,name)).some(a=>accountPolicy(root,name,a).connected);
}
/** Whether the provider lets BigBrain change this account at all, whatever a grant says. */
const providerWritable = (root:string,name:string,account:string):boolean => integrationNamed(name)?.writable?.(root,account) ?? true;
export function requireIntegrationWrite(root:string,name:string,account:string,caller:IntegrationCaller):void {
  if (caller.kind === "worker") throw new Error("Workers have read-only source access.");
  const id=integrationCallerId(root,caller),p=accountPolicy(root,name,account);
  if(!providerWritable(root,name,account)||!p.connected||accessOf(p,id)!=="read-write")throw new Error("This account does not grant this caller live write access.");
}

export function writableIntegrationAccounts(root:string,name:string,caller:IntegrationCaller):string[] {
  if (caller.kind === "worker") return [];
  const id=integrationCallerId(root,caller);
  return integrationAccounts(root,name).filter(a=>{const p=accountPolicy(root,name,a);return providerWritable(root,name,a)&&p.connected&&accessOf(p,id)==="read-write";});
}


export function integrationAccountEnvKey(name:string,account:string):string {
  const envKey=managed(name).credential.envKey;
  if(!envKey)throw new Error("This integration keeps no key.");
  return envKey(account);
}
export function integrationAccountKey(root:string,name:string,account:string):string|undefined {
  return readEnvValues(root)[integrationAccountEnvKey(name,account)];
}
