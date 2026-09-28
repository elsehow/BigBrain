/** Machine-local additional readable folders for Pilot. */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { readEnvValues, writeEnvValues } from "./envFile";

export type FileAccess = "read" | "write";
export interface FolderAccess { path: string; access: FileAccess }
export interface WorkPermissions { version: 2; folders: FolderAccess[]; legacyCowboy?: true }
const KEY = "BIGBRAIN_PILOT_AGENT_PERMISSIONS";
export function directoryPath(value: unknown): string {
  if (typeof value !== "string" || /[\x00-\x1f]/.test(value)) throw new Error("Choose an absolute folder path.");
  const expanded = value.trim() === "~" ? homedir() : value.trim().startsWith("~/") ? join(homedir(), value.trim().slice(2)) : value.trim();
  if (!isAbsolute(expanded)) throw new Error("Choose an absolute folder path.");
  const path = realpathSync(expanded);
  if (!statSync(path).isDirectory()) throw new Error("Choose an existing folder.");
  return path;
}
function decode(value: any, stored = false): WorkPermissions {
  if (value?.version === 2 && Array.isArray(value.folders) && value.folders.every((f: any) => f && typeof f.path === "string" && (!stored || isAbsolute(f.path)) && ["read", "write"].includes(f.access)))
    return { version: 2, folders: value.folders, ...(value.legacyCowboy ? { legacyCowboy: true as const } : {}) };
  if (typeof value?.cowboy === "boolean" && Array.isArray(value.directories) && value.directories.every((p: any) => typeof p === "string" && (!stored || isAbsolute(p))))
    return { version: 2, folders: value.directories.map((path: string) => ({ path, access: "write" })), ...(value.cowboy ? { legacyCowboy: true as const } : {}) };
  throw new Error("Invalid Pilot folder settings; update Vault > Pilot settings.");
}
export function readWorkPermissions(root: string): WorkPermissions {
  const raw = readEnvValues(root)[KEY];
  return raw ? decode(JSON.parse(raw), true) : { version: 2, folders: [] };
}
export function normalizeWorkPermissions(value: unknown): WorkPermissions {
  if ((value as any)?.cowboy) throw new Error("Pilot only supports read access to configured folders.");
  const v = decode(value);
  if (v.folders.length > 32) throw new Error("Choose at most 32 authorized folders.");
  const folders = new Map<string, FolderAccess>();
  for (const f of v.folders) {
    const path = directoryPath(f.path);
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

/** Demote historical write grants without resolving moved/missing directories.
 * Validation at use time remains fail-closed; users can repair paths in Settings. */
export function migratePilotReadSettings(root: string): void {
  const prior = readWorkPermissions(root);
  if (prior.legacyCowboy || prior.folders.some(f => f.access === "write"))
    writeEnvValues(root, { [KEY]: JSON.stringify({ version: 2, folders: prior.folders.map(f => ({ path: f.path, access: "read" })) }) });
}
