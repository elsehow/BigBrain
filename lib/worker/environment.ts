/** Explicit command credentials; values never enter project or worker records. */
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../fsx";
import { spoolDir } from "../spool";
import { workerEnvironment } from "./sandbox";

export const credentialName = /^[A-Z][A-Z0-9_]{1,79}$/;
export function validateCredentialName(name: string): boolean {
  return credentialName.test(name) && !/^(?:HOME|PATH|TMPDIR|SHELL|ENV|BASH_ENV|ZDOTDIR|NODE_OPTIONS|BUN_OPTIONS|PYTHONPATH|RUBYOPT|PERL5OPT|GIT_CONFIG.*|LD_.*|DYLD_.*|BIGBRAIN_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_.*|CURL_CA_BUNDLE|GIT_SSL_.*|REQUESTS_CA_BUNDLE|NODE_EXTRA_CA_CERTS)$/i.test(name);
}
export class EnvironmentCredentials {
  private file: string;
  constructor(root: string) { this.file = join(spoolDir(root), "project-credentials.json"); }
  private read(): Record<string, Record<string, string>> { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {}; }
  names(path: string): string[] { return Object.keys(this.read()[path] ?? {}).sort(); }
  values(path: string, names: string[]): Record<string, string> {
    const saved = this.read()[path] ?? {};
    return Object.fromEntries(names.map(name => {
      if (!validateCredentialName(name) || !saved[name]) throw new Error(`Reconnect credential ${name} in the project environment.`);
      return [name, saved[name]];
    }));
  }
  update(path: string, input: unknown): void {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 30) throw new Error("Provide up to 30 named credentials.");
    const saved = this.read(), next = { ...saved[path] };
    for (const [name, value] of Object.entries(input)) {
      if (!validateCredentialName(name)) throw new Error("Use a credential variable name, such as GH_TOKEN or NPM_TOKEN. Runtime configuration variables are not allowed.");
      if (value === null) delete next[name];
      else if (typeof value !== "string" || !value || value.length > 16_000 || value.includes("\0")) throw new Error(`Enter a value for ${name}.`);
      else next[name] = value;
    }
    saved[path] = next; writeAtomic(this.file, JSON.stringify(saved), 0o600); chmodSync(this.file, 0o600);
  }
  remove(path: string): void { const saved = this.read(); delete saved[path]; writeAtomic(this.file, JSON.stringify(saved), 0o600); chmodSync(this.file, 0o600); }
}
export function inspectEnvironment(path: string) {
  const env = workerEnvironment("/tmp");
  return { path, workspace: existsSync(join(path, ".git")) ? "checkout" : "direct",
    tools: ["git", "bun", "node", "npm", "python3", "gh"].map(name => ({ name, available: !!Bun.which(name, { PATH: env.PATH }) })) };
}
