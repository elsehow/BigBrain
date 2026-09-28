import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sha256hex } from "./hash";

export const VAULT_HEADER = "x-bigbrain-vault";
/** Stable across engine restarts, distinct for different filesystem vaults. */
export function vaultIdentity(root: string | null): string {
  if (root === null) return "setup";
  let path = resolve(root);
  try { path = realpathSync(path); } catch { /* Startup will report an inaccessible root. */ }
  return sha256hex(path);
}
/** Old tabs must never dispatch their pending writes against a newly selected vault. */
export function allowVaultRequest(req: IncomingMessage, res: ServerResponse, identity: string): boolean {
  res.setHeader(VAULT_HEADER, identity);
  const expected = req.headers[VAULT_HEADER];
  if (expected === undefined || expected === identity) return true;
  res.writeHead(409, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "The active vault changed. Reload before continuing." }));
  return false;
}
