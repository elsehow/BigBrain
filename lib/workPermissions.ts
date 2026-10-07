/** Machine-local additional readable folders for Pilot. */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { readEnvValues, writeEnvValues } from "./envFile";

export type FileAccess = "read" | "write";
export interface FolderAccess { path: string; access: FileAccess }
/** A saved folder that no longer qualifies; it grants nothing and Settings says why. */
export interface RemovedFolder { path: string; reason: string }
export interface WorkPermissions { version: 2; folders: FolderAccess[]; legacyCowboy?: true; removed?: RemovedFolder[] }
const KEY = "BIGBRAIN_PILOT_AGENT_PERMISSIONS";
/** Home-relative credential stores: Pilot never reads them, and no folder grant may contain them. */
const CREDENTIAL_PATHS = [".codex", ".claude", ".ssh", ".aws", ".pi", ".config/bigbrain", ".config/gh", ".config/gcloud", ".netrc", ".git-credentials", ".npmrc", ".pypirc",
  ".docker", ".kube", ".gnupg", ".azure", "Library/Keychains", "Library/Cookies", ".zsh_history", ".zsh_sessions", ".bash_history", ".sh_history", ".local/share/fish/fish_history"];
/** Names Pilot never reads wherever they appear: secret-bearing files, and `.git`
 * (remote URLs can embed tokens). Sample env files are documentation. */
const SECRET_NAME = /^(\.git|\.env(\..+)?|\.envrc|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.pgpass|\.htpasswd|credentials\.json|service-account.*\.json|.+\.(pem|key|p12|pfx)|id_(rsa|dsa|ecdsa|ed25519).*)$/i;
export const secretName = (name: string): boolean => SECRET_NAME.test(name) && !/^\.env\.(example|sample)$/i.test(name);
export const expandHome = (path: string): string => path.replace(/^~(?=\/|$)/, homedir());
export function credentialPaths(): string[] {
  const agents = [process.env.PI_CODING_AGENT_DIR, process.env.CODEX_HOME].filter((p): p is string => !!p).map(expandHome);
  return [...CREDENTIAL_PATHS.map(p => join(homedir(), p)), ...agents].map(canonicalWorkPath);
}
const tilde = (path: string, home: string): string => containsPath(home, path) ? "~" + path.slice(home.length) : path;
/** Why a canonical folder is too broad to grant, or null. */
export function folderRefusal(path: string, credentials = credentialPaths()): string | null {
  const home = canonicalWorkPath(homedir());
  if (dirname(path) === path) return "Pilot cannot read the whole disk. Choose a specific folder, such as a project folder.";
  if (path === home) return "Pilot cannot read your whole home folder. Choose a specific folder inside it, such as a project folder.";
  if (containsPath(path, home)) return "This folder contains your home folder. Choose a specific folder inside your home folder, such as a project folder.";
  const store = credentials.find(p => containsPath(path, p) || containsPath(p, path));
  if (!store) return null;
  return containsPath(path, store)
    ? `This folder contains ${tilde(store, home)}, which holds credentials. Choose a more specific folder.`
    : `This folder is part of ${tilde(store, home)}, which holds credentials. Pilot cannot read it.`;
}
export function directoryPath(value: unknown, credentials = credentialPaths()): string {
  if (typeof value !== "string" || /[\x00-\x1f]/.test(value)) throw new Error("Choose an absolute folder path.");
  const expanded = expandHome(value.trim());
  if (!isAbsolute(expanded)) throw new Error("Choose an absolute folder path.");
  let path: string;
  try { path = realpathSync(expanded); } catch { throw new Error(`Choose an existing folder: ${value.trim()} was not found.`); }
  if (!statSync(path).isDirectory()) throw new Error("Choose an existing folder.");
  const refused = folderRefusal(path, credentials);
  if (refused) throw new Error(refused);
  return path;
}
function decode(value: any, stored = false): WorkPermissions {
  if (value?.version === 2 && Array.isArray(value.folders) && value.folders.every((f: any) => f && typeof f.path === "string" && (!stored || isAbsolute(f.path)) && ["read", "write"].includes(f.access)))
    return { version: 2, folders: value.folders, ...(value.legacyCowboy ? { legacyCowboy: true as const } : {}) };
  if (typeof value?.cowboy === "boolean" && Array.isArray(value.directories) && value.directories.every((p: any) => typeof p === "string" && (!stored || isAbsolute(p))))
    return { version: 2, folders: value.directories.map((path: string) => ({ path, access: "write" })), ...(value.cowboy ? { legacyCowboy: true as const } : {}) };
  throw new Error("Invalid Pilot folder settings; update Vault > Pilot settings.");
}
/** Saved folders that are now refused never grant: they move to `removed`,
 * where Settings shows them until the next save. */
export function readWorkPermissions(root: string): WorkPermissions {
  const raw = readEnvValues(root)[KEY];
  if (!raw) return { version: 2, folders: [] };
  const value = JSON.parse(raw), stored = decode(value, true), credentials = credentialPaths();
  const removed: RemovedFolder[] = Array.isArray(value.removed) ? value.removed.filter((r: any) => typeof r?.path === "string" && typeof r?.reason === "string") : [];
  const folders = stored.folders.filter(f => {
    const reason = folderRefusal(canonicalWorkPath(f.path), credentials);
    if (reason) removed.push({ path: f.path, reason });
    return !reason;
  });
  return { ...stored, folders, ...(removed.length ? { removed } : {}) };
}
export function normalizeWorkPermissions(value: unknown): WorkPermissions {
  if ((value as any)?.cowboy) throw new Error("Pilot only supports read access to configured folders.");
  const v = decode(value);
  if (v.folders.length > 32) throw new Error("Choose at most 32 authorized folders.");
  const folders = new Map<string, FolderAccess>(), credentials = credentialPaths();
  for (const f of v.folders) {
    const path = directoryPath(f.path, credentials);
    const prior = folders.get(path);
    folders.set(path, { path, access: prior?.access === "write" ? "write" : f.access });
  }
  return { version: 2, folders: [...folders.values()] };
}
export function validatedWorkPermissions(root: string): WorkPermissions {
  const stored = readWorkPermissions(root);
  const validated = normalizeWorkPermissions(stored);
  if (JSON.stringify(validated.folders) !== JSON.stringify(stored.folders)) throw new Error("An authorized directory changed location. Choose it again in Vault > Pilot settings.");
  return validated;
}
export function saveWorkPermissions(root: string, permissions: unknown): void {
  writeEnvValues(root, { [KEY]: JSON.stringify(normalizeWorkPermissions(permissions)) });
}
export function containsPath(parent: string, path: string): boolean { return path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep); }
/** Existing ancestors resolve symlinks even for a file that has not been created. */
export function canonicalWorkPath(path: string): string {
  if (!isAbsolute(path)) throw new Error("Expected an absolute path");
  try { return realpathSync(path); }
  catch {
    const parent = dirname(path);
    if (parent === path) throw new Error("Cannot resolve directory");
    return join(canonicalWorkPath(parent), basename(path));
  }
}
export function withinWorkDirectories(path: string, directories: readonly string[]): boolean {
  const canonical = canonicalWorkPath(path);
  return directories.some(root => canonical === root || canonical.startsWith(root.endsWith(sep) ? root : root + sep));
}

/** Demote historical write grants and drop refused folders (recording why)
 * without resolving moved/missing directories. Validation at use time remains
 * fail-closed; users can repair paths in Settings. */
export function migratePilotReadSettings(root: string): void {
  const raw = readEnvValues(root)[KEY];
  if (!raw) return;
  const prior = readWorkPermissions(root);
  const next = JSON.stringify({ version: 2, folders: prior.folders.map(f => ({ path: f.path, access: "read" })), ...(prior.removed ? { removed: prior.removed } : {}) });
  if (next !== raw) writeEnvValues(root, { [KEY]: next });
}
