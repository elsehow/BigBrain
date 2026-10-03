/**
 * workspace.ts — the folders this package owns.
 *
 *   <root>/projects/<name>/     home copies (the person's projects)
 *   <root>/desktops/<id>/       a desktop's folder, and its agent's cwd
 *   <root>/.agents/<id>/        this package's state for a desktop
 *
 * A desktop's folder mirrors projects/: a project the desktop hasn't
 * changed is a relative link to its home copy, and a forked one is a real
 * folder (fork.ts). Sibling paths such as `../other-project/` resolve the
 * same way inside a fork as in the home copy.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

export interface Workspace { root: string; projects: string; desktops: string; state: string }
export interface Project { name: string; path: string }
export type ProjectState = "link" | "fork" | "absent";

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
    .filter(e => PROJECT_NAME.test(e.name) && !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
    .map(e => ({ name: e.name, path: join(ws.projects, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function projectState(ws: Workspace, id: string, name: string): ProjectState {
  const entry = join(ws.desktops, checkDesktopId(id), name);
  try { return lstatSync(entry).isSymbolicLink() ? "link" : "fork"; } catch { return "absent"; }
}

/** A desktop's folder, created on demand, with a link for every project it hasn't forked. */
export function desktopFolder(ws: Workspace, id: string): string {
  const dir = join(ws.desktops, checkDesktopId(id));
  mkdirSync(dir, { recursive: true });
  for (const p of listProjects(ws)) {
    const entry = join(dir, p.name);
    const target = relative(dir, p.path);
    try {
      const st = lstatSync(entry);
      if (st.isSymbolicLink() && readlinkSync(entry) !== target) throw new AgentsError(`${entry} links somewhere unexpected.`);
      continue; // a fork, or the right link already
    } catch (error) {
      if (error instanceof AgentsError) throw error;
    }
    symlinkSync(target, entry);
  }
  return dir;
}

export const stateFolder = (ws: Workspace, id: string): string => {
  const dir = join(ws.state, checkDesktopId(id));
  mkdirSync(dir, { recursive: true });
  return dir;
};
