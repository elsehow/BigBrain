import {INCLUDE_EVERYTHING} from './inclusionMode';
/** Account access owned by BigBrain, independent of native agent permissions. */
import { granolaConnection } from "./granolaMcp";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadManifest, integrationEnabledIn } from "./manifest";
import { emailConfig, passwordEnvKey, gmailReadOnly } from "./emailConfig";
import { readEnvValues } from "./envFile";
import { writeAtomic } from "./fsx";
import { listTokens, tokenStorePath, verifyToken, hasScope } from "./auth";

export const MANAGED_INTEGRATIONS = new Set(["email", "granola", "that-tracks"]);
export interface IntegrationGrant { caller: string; accounts: string[] }
export interface IntegrationActivation {
  version: 1; active: boolean; fingerprint: string; checkedAt: string; grants: IntegrationGrant[];
}
export type IntegrationCaller = { kind: "worker"; accounts: { integration: string; account: string }[] } | { kind: "pilot" | "gardener" } | { kind: "mcp"; token?: string; storePath?: string };
const file = (root: string, name: string) => {
  if (!MANAGED_INTEGRATIONS.has(name)) throw new Error("This integration has no activation adapter.");
  return join(root, ".spool", "integration-access", name + ".json");
};
export function activationRecord(root: string, name: string): IntegrationActivation | undefined {
  try {
    const v = JSON.parse(readFileSync(file(root, name), "utf8"));
    if (v.version !== 1 || typeof v.active !== "boolean" || typeof v.fingerprint !== "string" || typeof v.checkedAt !== "string" || !Array.isArray(v.grants)) return;
    if (v.grants.some((g: any) => typeof g.caller !== "string" || !Array.isArray(g.accounts) || g.accounts.some((a: unknown) => typeof a !== "string"))) return;
    return v;
  } catch { return; }
}
export function integrationAccounts(root: string, name: string): string[] {
  return name === "email" ? emailConfig(loadManifest(root).integrations.email).inboxes.map(i => i.address) : [name,...extraAccounts(root,name).map(a=>a.id)];
}
function legacyRememberingRule(root: string, name: string): string {
  const value = loadManifest(root).integrations[name]?.remember;
  return typeof value === "string" ? value.trim() : "";
}
/** Credentials never leave the host. Changing account settings invalidates the check. */
export function integrationFingerprint(root: string, name: string): string {
  const cfg = loadManifest(root).integrations[name] ?? {};
  const { enabled: _e, remember: _r, skip: _s, ...connection } = cfg;
  const env = readEnvValues(root);
  const keys = name === "email" ? integrationAccounts(root, name).map(passwordEnvKey) : [name === "granola" ? "GRANOLA_API_KEY" : "THAT_TRACKS_API_KEY"];
  return createHash("sha256").update(JSON.stringify([connection, keys.map(k => env[k] ?? "")])).digest("hex");
}
export function integrationActive(root: string, name: string, account?: string): boolean {
  if (!MANAGED_INTEGRATIONS.has(name)) return integrationEnabledIn(loadManifest(root).integrations,name);
  return (account ? [account] : integrationAccounts(root,name)).some(a => {
    const policy=accountPolicy(root,name,a);return policy.connected && policy.remembering.enabled && !!policy.remembering.rule.trim();
  });
}
export function rememberingRule(root:string,name:string,account?:string):string {
  return account ? accountPolicy(root,name,account).remembering.rule : legacyRememberingRule(root,name);
}
export function integrationCallerChoices(root: string) {
  return [{ id: "pilot", label: "Pilot" },
    ...listTokens(tokenStorePath(root)).filter(t => !t.revoked && hasScope(t, "vault:read"))
      .map(t => ({ id: "token:" + t.id, label: t.name }))];
}
export function validateIntegrationGrants(root: string, name: string, value: unknown): IntegrationGrant[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Choose who can read this integration.");
  const callers = new Set(integrationCallerChoices(root).map(c => c.id)), accounts = new Set(integrationAccounts(root, name));
  const seen = new Set<string>();
  return value.map(g => {
    if (!g || !callers.has(g.caller) || seen.has(g.caller) || !Array.isArray(g.accounts) || g.accounts.some((a: unknown) => typeof a !== "string" || !accounts.has(a))) throw new Error("Choose an existing caller and account.");
    seen.add(g.caller);
    return { caller: g.caller, accounts: [...new Set<string>(g.accounts)] };
  });
}
export function saveIntegrationActivation(root: string, name: string, grants: IntegrationGrant[], fingerprint: string): void {
  if (!rememberingRule(root, name)) throw new Error("Enter a remembering rule before activating.");
  if (fingerprint !== integrationFingerprint(root, name)) throw new Error("Account settings changed during the access check. Try again.");
  const record: IntegrationActivation = { version: 1, active: true, fingerprint, checkedAt: new Date().toISOString(), grants };
  writeAtomic(file(root, name), JSON.stringify(record) + "\n", 0o600);
  for(const account of integrationAccounts(root,name))writeAccountPolicy(root,name,account,{version:2,connected:true,fingerprint:accountFingerprint(root,name,account),checkedAt:record.checkedAt,remembering:{enabled:true,rule:rememberingRule(root,name)},grants:grants.filter(g=>g.accounts.includes(account)).map(g=>({caller:g.caller,access:"read"}))});
}
export function deactivateIntegration(root: string, name: string): void {
  const policies = integrationAccounts(root,name).map(account => ({account,policy:accountPolicy(root,name,account)}));
  const prior = activationRecord(root, name);
  for (const {account,policy} of policies) writeAccountPolicy(root,name,account,{...policy,connected:false});
  writeAtomic(file(root, name), JSON.stringify({ version:1, fingerprint:"", checkedAt:new Date().toISOString(), grants:[], ...prior, active: false }) + "\n", 0o600);
}
function callerId(root: string, caller: IntegrationCaller): string {
  if (caller.kind === "gardener") throw new Error("Gardener reads landed arrivals only; live accounts are unavailable.");
  if (caller.kind !== "mcp") return caller.kind;
  const result = verifyToken(caller.storePath ?? tokenStorePath(root), caller.token ?? "");
  if (!result.ok || !hasScope(result.record, "vault:read")) throw new Error("Authenticate this MCP client with a current vault-read credential.");
  return "token:" + result.record.id;
}
export function readableIntegrationAccounts(root: string, name: string, caller: IntegrationCaller): string[] {
  if (caller.kind === "worker") return readableIntegrationAccounts(root, name, {kind: "pilot"}).filter(a => caller.accounts.some(g => g.integration === name && g.account === a));
  const id = callerId(root, caller);
  return integrationAccounts(root,name).filter(a => { const p=accountPolicy(root,name,a);return p.connected && (p.liveAccess??["read","read-write"].includes(p.grants.find(g=>g.caller===id)?.access ?? "off")); });
}
export function requireIntegrationRead(root: string, name: string, account: string, caller: IntegrationCaller): void {
  if (!readableIntegrationAccounts(root, name, caller).includes(account))
    throw new Error("This account is not available to this caller. Update access in Settings → Integrations.");
}

export type LiveAccess = "off" | "read" | "read-write";
export interface AccountPolicy {
  version:2; connected:boolean; fingerprint:string; checkedAt:string|null; liveAccess?:boolean;
  email?: { startAt: string; attachments: boolean; backfill?: { since: string; request: string } };
  remembering:{enabled:boolean;rule:string;inactiveRule?:string}; grants:{caller:string;access:LiveAccess}[];
}
function accountPolicyFile(root:string,name:string,account:string):string {
  file(root,name); // Validate the adapter namespace.
  return join(root,".spool","integration-accounts",name,createHash("sha256").update(account).digest("hex")+".json");
}
export function accountFingerprint(root:string,name:string,account:string):string {
  if (!integrationAccounts(root,name).includes(account)) throw new Error("Choose a configured account.");
  if(name==="granola")return createHash("sha256").update(JSON.stringify([account,granolaConnection(root,account)?.generation??"disconnected"])).digest("hex");
  if(name!=="email")return createHash("sha256").update(JSON.stringify([account,integrationAccountKey(root,name,account)])).digest("hex");
  const inbox=emailConfig(loadManifest(root).integrations.email).inboxes.find(i=>i.address===account);
  return createHash("sha256").update(JSON.stringify([inbox,readEnvValues(root)[passwordEnvKey(account)] ?? ""])).digest("hex");
}
const LEGACY_GRANOLA_RULE = "Record raw transcripts, correcting garbled ASR with vault context. Ignore Granola's automated summary.";
export const GRANOLA_REMEMBERING_RULE = INCLUDE_EVERYTHING;
export function accountPolicy(root:string,name:string,account:string):AccountPolicy {
  const empty:AccountPolicy={version:2,connected:false,fingerprint:"",checkedAt:null,remembering:{enabled:false,rule:name==="granola"?GRANOLA_REMEMBERING_RULE:""},grants:[]};
  if(!integrationAccounts(root,name).includes(account))return empty;
  let raw:string;
  try{raw=readFileSync(accountPolicyFile(root,name,account),"utf8");}
  catch(e){
    if((e as NodeJS.ErrnoException).code!=="ENOENT")return empty;
    // Tolerant read of explicit prior activation; never infer consent from credentials.
    if(name==="granola"||(name!=="email"&&account!==name))return empty;
    const old=activationRecord(root,name),rule=legacyRememberingRule(root,name);
    const valid=!!old?.active && integrationEnabledIn(loadManifest(root).integrations,name) && !!rule && old.fingerprint===integrationFingerprint(root,name);
    return {...empty,connected:valid,fingerprint:valid?accountFingerprint(root,name,account):"",checkedAt:old?.checkedAt??null,
      remembering:{enabled:valid,rule},grants:(old?.grants??[]).filter(g=>g.accounts.includes(account)).map(g=>({caller:g.caller,access:"read"}))};
  }
  try {
    const p=JSON.parse(raw);
    if(p.version!==2||typeof p.connected!=="boolean"||typeof p.fingerprint!=="string"||!p.remembering||typeof p.remembering.enabled!=="boolean"||typeof p.remembering.rule!=="string"||!Array.isArray(p.grants)||p.grants.some((g:any)=>typeof g.caller!=="string"||!["off","read","read-write"].includes(g.access)))return empty;
    if(p.liveAccess!==undefined&&typeof p.liveAccess!=="boolean")return empty;
    return {...p,remembering:{...p.remembering,rule:name==="granola"&&p.remembering.rule===LEGACY_GRANOLA_RULE?GRANOLA_REMEMBERING_RULE:p.remembering.rule.trim()?p.remembering.rule:empty.remembering.rule},connected:p.connected&&(name!=="granola"||!!granolaConnection(root,account))&&p.fingerprint===accountFingerprint(root,name,account)};
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
export function requireIntegrationWrite(root:string,name:string,account:string,caller:IntegrationCaller):void {
  if (caller.kind === "worker") throw new Error("Workers have read-only source access.");
  const id=callerId(root,caller),p=accountPolicy(root,name,account);
  if((name==="email"&&gmailReadOnly(root,account))||!p.connected||!(p.liveAccess??(p.grants.find(g=>g.caller===id)?.access==="read-write")))throw new Error("This account does not grant this caller live write access.");
}

export function writableIntegrationAccounts(root:string,name:string,caller:IntegrationCaller):string[] {
  if (caller.kind === "worker") return [];
  const id=callerId(root,caller);
  return integrationAccounts(root,name).filter(a=>{const p=accountPolicy(root,name,a);return !(name==="email"&&gmailReadOnly(root,a))&&p.connected&&(p.liveAccess??(p.grants.find(g=>g.caller===id)?.access==="read-write"));});
}

export function extraAccounts(root:string,name:string):{id:string;label:string}[] {
  if(name==="email")return [];
  try{const v=JSON.parse(readFileSync(join(root,".spool","integration-accounts",name,"accounts.json"),"utf8"));return Array.isArray(v)?v.filter(a=>typeof a.id==="string"&&/^account-[a-f0-9]{16}$/.test(a.id)&&typeof a.label==="string"):[];}catch{return [];}
}
export function integrationAccountEnvKey(name:string,account:string):string {
  const base=name==="granola"?"GRANOLA_API_KEY":"THAT_TRACKS_API_KEY";
  return account===name?base:base+"__"+account.replaceAll("-","_").toUpperCase();
}
export function integrationAccountKey(root:string,name:string,account:string):string|undefined {
  return readEnvValues(root)[integrationAccountEnvKey(name,account)];
}
