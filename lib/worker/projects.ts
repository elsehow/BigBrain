/** Only trusted desktop routes may create grants. Model tools may propose them. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { writeAtomic } from "../fsx";
import { spoolDir } from "../spool";
import { validateModelChoice, type ModelChoice } from "../modelChoice";
import { integrationAccounts, readableIntegrationAccounts } from "../integrationAccess";
import { EnvironmentCredentials, inspectEnvironment, validateCredentialName } from "./environment";
import { protectedProjectPaths } from "./protectedPaths";
const account = z.object({ integration: z.enum(["email", "granola"]), account: z.string().min(1).max(300) }).strict();
export const grantSchema = z.object({ path: z.string().min(1).max(4000), mode: z.enum(["read", "work"]), references: z.array(z.string().max(4000)).max(20), domains: z.array(z.string().max(253)).max(30), accounts: z.array(account).max(30), network: z.enum(["public"]).optional(), credentials: z.array(z.string().refine(validateCredentialName)).max(30).optional() }).strict();
export type ProjectGrant = z.infer<typeof grantSchema>;
export interface Project extends ProjectGrant { id: string; label: string; updated: string; model?: ModelChoice }
export const inside = (path: string, root: string) => path === root || (!relative(root, path).startsWith("..") && !isAbsolute(relative(root, path)));
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
export function covers(grant: ProjectGrant, request: ProjectGrant): boolean {
  return grant.path === request.path && (grant.mode === "work" || request.mode === "read") && request.references.every(p => grant.references.includes(p)) && (grant.network === "public" || (!request.network && request.domains.every(d => grant.domains.includes(d)))) && (request.credentials ?? []).every(n => (grant.credentials ?? []).includes(n)) && request.accounts.every(a => grant.accounts.some(b => a.integration === b.integration && a.account === b.account));
}
export class Projects {
  private records = new Map<string, Project>();
  private listeners = new Set<() => void>();
  private file: string;
  readonly credentials: EnvironmentCredentials;
  constructor(readonly root: string) {
    this.credentials = new EnvironmentCredentials(root);
    this.file = join(spoolDir(root), "projects.json");
    if (!existsSync(this.file)) return;
    const saved = JSON.parse(readFileSync(this.file, "utf8"));
    if (!Array.isArray(saved)) throw new Error("Saved project permissions are invalid. Execution is blocked.");
    for (const v of saved) {
      const grant = grantSchema.parse({ path: v.path, mode: v.mode, references: v.references, domains: v.domains, accounts: v.accounts, network: v.network, credentials: v.credentials });
      if (!/^project-[a-f0-9]{32}$/.test(v.id) || typeof v.label !== "string" || typeof v.updated !== "string") throw new Error("Invalid saved project.");
      this.records.set(v.id, { ...grant, id: v.id, label: v.label, updated: v.updated, ...(v.model ? { model: validateModelChoice(v.model) } : {}) });
    }
  }
  list(): Project[] { return structuredClone([...this.records.values()]); }
  get(id: string): Project | undefined { const p = this.records.get(id); return p ? structuredClone(p) : undefined; }
  at(path: string): Project | undefined { return this.list().find(p => p.path === path); }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed() { writeAtomic(this.file, JSON.stringify(this.list()), 0o600); for (const fn of this.listeners) fn(); }
  folder(value: string): string {
    if (!isAbsolute(value) || !statSync(value).isDirectory()) throw new Error("Choose an existing absolute project folder.");
    const path = realpathSync(value), home = realpathSync(homedir()), vault = realpathSync(this.root);
    const protectedRoots = [vault, ...[".pi", ".claude", ".codex", ".ssh", ".aws", ".config"].map(p => join(home, p))];
    if (inside(home, path) || protectedRoots.some(p => overlaps(path, p)) || ["/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/private/etc", "/dev", "/proc", "/sys"].some(p => overlaps(path, p)))
      throw new Error("Choose a specific project outside the vault, system folders, and account credentials.");
    return path;
  }
  validate(value: unknown): ProjectGrant {
    const g = grantSchema.parse(value), path = this.folder(g.path), references = [...new Set(g.references.map(p => this.folder(p)))];
    if (references.some(p => overlaps(p, path))) throw new Error("Reference folders must be separate from the project.");
    const domains = [...new Set(g.domains.map(d => d.toLowerCase()))];
    if (domains.some(d => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(d) || d.endsWith(".localhost") || d.endsWith(".local") || d.endsWith(".internal"))) throw new Error("Use exact public domain names, without wildcards, URLs, ports, or local addresses.");
    for (const a of g.accounts) if (!integrationAccounts(this.root, a.integration).includes(a.account) || !readableIntegrationAccounts(this.root, a.integration, { kind: "pilot" }).includes(a.account)) throw new Error("Choose a connected account with live access enabled.");
    protectedProjectPaths([path, ...references]);
    return { path, mode: g.mode, references, domains, accounts: g.accounts, ...(g.network ? { network: g.network } : {}), ...(g.credentials ? { credentials: [...new Set(g.credentials)] } : {}) };
  }
  save(value: unknown): Project {
    const v = value as Record<string, unknown>;
    if (!v || typeof v !== "object" || typeof v.label !== "string" || !v.label.trim() || v.label.length > 100) throw new Error("Enter a project name under 100 characters.");
    const g = this.validate({ path: v.path, mode: v.mode, references: v.references ?? [], domains: v.domains ?? [], accounts: v.accounts ?? [], network: v.network, credentials: v.credentials });
    this.credentials.values(g.path, g.credentials ?? []);
    const old = v.id ? this.get(String(v.id)) : this.at(g.path);
    if (v.id && !old) throw new Error("Project authorization no longer exists.");
    if (old && old.path !== g.path) throw new Error("Add a new project to change its folder.");
    const p: Project = { ...g, id: old?.id ?? `project-${crypto.randomUUID().replaceAll("-", "")}`, label: v.label.trim(), updated: new Date().toISOString(), ...(v.model ? { model: validateModelChoice(v.model) } : {}) };
    this.records.set(p.id, p); this.changed(); return structuredClone(p);
  }
  connect(path: string, values: unknown) {
    const folder = this.folder(path);
    this.credentials.update(folder, values);
    const project = this.at(folder), names = this.credentials.names(folder);
    if (project) {
      this.records.set(project.id, { ...project, credentials: (project.credentials ?? []).filter(n => names.includes(n)), updated: new Date().toISOString() });
      this.changed();
    }
    return { names };
  }
  inspect(path: string) { const folder = this.folder(path); return { ...inspectEnvironment(folder), credentials: this.credentials.names(folder) }; }
  remove(id: unknown) { const prior = this.get(String(id)); if (!this.records.delete(String(id))) throw new Error("Project authorization no longer exists."); this.changed(); if (prior) this.credentials.remove(prior.path); }
}
