/**
 * workspace.ts — the folders this package works with.
 *
 *   <root>/projects/<name>/     the person's projects, where agents work in place
 *   <root>/desktops/<id>/<name> a desktop's own worktree of a project (worktree.ts)
 *   <root>/.agents/<id>/        this package's state for a desktop
 *
 * An agent's working folder is <root>: it reaches the person's projects at
 * projects/<name> and its own worktrees at desktops/<id>/<name>.
 *
 * Editing a project in place takes a lease, so two desktops don't edit the
 * same copy at once: the second is told to start_work instead. Leases are
 * released when a desktop is archived.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Workspace {
  root: string; projects: string; desktops: string; state: string;
  /** What the programs this package runs for itself (git, cp, gh) get as their
   * environment: the host's choice. Absent: this process's. */
  env?: () => NodeJS.ProcessEnv;
}
export interface Project { name: string; path: string }

export class AgentsError extends Error {}

const DESKTOP_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function workspace(root = process.env["BIGBRAIN_WORKSPACE"] || join(homedir(), "bigbrain")): Workspace {
  return { root, projects: join(root, "projects"), desktops: join(root, "desktops"), state: join(root, ".agents") };
}

export function checkDesktopId(id: string): string {
  if (!DESKTOP_ID.test(id)) throw new AgentsError(`A desktop id is 3–64 lowercase letters, digits or dashes: ${JSON.stringify(id)}`);
  return id;
}

/** The projects in the workspace: every folder (or link to one) under projects/. */
export function listProjects(ws: Workspace): Project[] {
  if (!existsSync(ws.projects)) return [];
  return readdirSync(ws.projects, { withFileTypes: true })
    .filter(e => PROJECT_NAME.test(e.name) && (e.isDirectory() || e.isSymbolicLink()))
    .map(e => ({ name: e.name, path: join(ws.projects, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const stateFolder = (ws: Workspace, id: string): string => {
  const dir = join(ws.state, checkDesktopId(id));
  mkdirSync(dir, { recursive: true });
  return dir;
};

// ── leases on in-place edits ──────────────────────────────────────────────────
const leaseFile = (ws: Workspace, project: string) => join(ws.state, "leases", `${project}.json`);

/** Take (or keep) the lease on editing a project in place. Returns the
 * desktop that holds it when that's another one. */
export function takeLease(ws: Workspace, id: string, project: string): string | undefined {
  const file = leaseFile(ws, project);
  if (existsSync(file)) {
    const holder = (JSON.parse(readFileSync(file, "utf8")) as { desktop: string }).desktop;
    return holder !== id ? holder : undefined;
  }
  mkdirSync(join(ws.state, "leases"), { recursive: true });
  writeFileSync(file, JSON.stringify({ desktop: id, at: new Date().toISOString() }));
  return undefined;
}

export function releaseLeases(ws: Workspace, id: string): void {
  const dir = join(ws.state, "leases");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const file = join(dir, f);
    try { if ((JSON.parse(readFileSync(file, "utf8")) as { desktop: string }).desktop === id) rmSync(file); } catch { rmSync(file, { force: true }); }
  }
}
