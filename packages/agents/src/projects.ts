/**
 * projects.ts — a contained desktop's copies of the person's projects (the
 * plan's Projects).
 *
 * A project enters a machine by value: host git makes a bundle in the
 * person's checkout, the bundle is written into the machine, and the guest
 * clones it to /work/<name>, on the person's current branch, then branches
 * desktop/<id> from it. Nothing is mounted, and the copy never shares a
 * hook, a config or an object with the checkout. Sync sends a fresh bundle
 * and fetches it. The real checkout is answered for by host git, read-only
 * (projectState), so a question about it gets a true answer.
 *
 * Host git runs only in projects/<name> (a project the workspace lists) and
 * writes only to files at paths the host chose (the plan's I8).
 */
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Guest } from "./guest";
import { run } from "./run";
import { AgentsError, listProjects, stateFolder, type Workspace } from "./workspace";

/** Where copies live in a machine. */
export const WORK = "/work";
const BUNDLE_MAX = 256 * 1024 * 1024;
const WHOLE_MAX = 1024 * 1024 * 1024;

export interface CopyRecord { project: string; base: string; branch: string; desktopBranch: string; at: string; bytes: number; ms: number; partial: boolean }

const git = (ws: Workspace, cwd: string, ...args: string[]) => run("git", args, cwd, ws.env?.());

function project(ws: Workspace, name: string): string {
  const p = listProjects(ws).find(x => x.name === name);
  if (!p) throw new AgentsError(`There is no project ${JSON.stringify(name)}. Your person's projects: ${listProjects(ws).map(x => x.name).join(", ") || "none yet"}.`);
  return p.path;
}

async function out(ws: Workspace, cwd: string, ...args: string[]): Promise<string> {
  const r = await git(ws, cwd, ...args);
  if (r.code !== 0) throw new AgentsError(`git ${args[0]} failed in ${cwd.split("/").pop()}: ${r.err.trim().slice(0, 300)}`);
  return r.out.trim();
}

/** Run a script in the guest as work; its output, or an AgentsError with it. */
async function inGuest(g: Guest, script: string, what: string): Promise<string> {
  let text = "";
  const x = await g.exec(["/bin/bash", "-c", `set -e\n${script}`], { cwd: WORK }, (_k, d) => { text += d; });
  const e = await x.exit;
  if (e.code !== 0) throw new AgentsError(`${what} failed in the machine: ${text.trim().slice(-400)}`);
  return text.trim();
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A bundle of a project, made by host git at a host-chosen path: every ref, or over 1 GiB the current branch and tags. */
async function bundle(ws: Workspace, desktop: string, name: string): Promise<{ file: string; partial: boolean; head: string; branch: string }> {
  const home = project(ws, name);
  const dir = join(stateFolder(ws, desktop), "in");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.bundle`);
  rmSync(file, { force: true });
  const head = await out(ws, home, "rev-parse", "HEAD");
  const branch = (await git(ws, home, "symbolic-ref", "--short", "-q", "HEAD")).out.trim();
  await out(ws, home, "bundle", "create", "-q", file, "--branches", "--tags", "HEAD");
  let partial = false;
  if (statSync(file).size > WHOLE_MAX) {
    rmSync(file);
    await out(ws, home, "bundle", "create", "-q", file, ...(branch ? [branch] : []), "--tags", "HEAD");
    partial = true;
  }
  if (statSync(file).size > BUNDLE_MAX) {
    rmSync(file);
    throw new AgentsError(`${name}'s history is over ${BUNDLE_MAX / 2 ** 20} MiB even without its other branches, too large to copy into a desktop yet.`);
  }
  return { file, partial, head, branch };
}

/** Copy a project into the desktop's machine, on desktop/<id>. Opening it again keeps the copy. */
export async function openProject(ws: Workspace, desktop: string, g: Guest, name: string): Promise<CopyRecord> {
  const t0 = Date.now();
  const where = `${WORK}/${name}`;
  const existing = await g.stat(`${where}/.git`).catch(() => undefined);
  if (existing) {
    const head = await inGuest(g, `cd ${shq(where)} && git rev-parse HEAD`, "Reading the copy");
    return { project: name, base: head, branch: "", desktopBranch: `desktop/${desktop}`, at: new Date().toISOString(), bytes: 0, ms: Date.now() - t0, partial: false };
  }
  const b = await bundle(ws, desktop, name);
  const data = readFileSync(b.file);
  await g.write(`${WORK}/.in/${name}.bundle`, data, { parents: true });
  const home = project(ws, name);
  const userName = (await git(ws, home, "config", "user.name")).out.trim();
  const userEmail = (await git(ws, home, "config", "user.email")).out.trim();
  const mine = `desktop/${desktop}`;
  await inGuest(g, [
    `rm -rf ${shq(where)}`,
    `git clone -q --no-checkout ${shq(`${WORK}/.in/${name}.bundle`)} ${shq(where)}`,
    `cd ${shq(where)}`,
    // every branch of the person's, as a local branch, as in their checkout
    `git for-each-ref --format='%(refname:strip=3)' refs/remotes/origin | grep -vx HEAD | while read -r br; do git update-ref "refs/heads/$br" "refs/remotes/origin/$br"; done`,
    userName ? `git config user.name ${shq(userName)}` : ":",
    userEmail ? `git config user.email ${shq(userEmail)}` : ":",
    b.branch ? `git checkout -q ${shq(b.branch)}` : `git checkout -q --detach ${shq(b.head)}`,
    `git checkout -q -B ${shq(mine)}`,
  ].join("\n"), `Copying ${name}`);
  const record: CopyRecord = { project: name, base: b.head, branch: b.branch, desktopBranch: mine, at: new Date().toISOString(), bytes: data.length, ms: Date.now() - t0, partial: b.partial };
  return record;
}

/** Bring a copy's view of the person's branches up to date with the checkout. The copy's own branch is left alone. */
export async function syncProject(ws: Workspace, desktop: string, g: Guest, name: string): Promise<{ from: string; to: string; bytes: number }> {
  const where = `${WORK}/${name}`;
  if (!(await g.stat(`${where}/.git`).catch(() => undefined))) throw new AgentsError(`${name} isn't open in this desktop yet: open_project first.`);
  const b = await bundle(ws, desktop, name);
  const data = readFileSync(b.file);
  await g.write(`${WORK}/.in/${name}.bundle`, data, { parents: true });
  const from = await inGuest(g, `cd ${shq(where)} && git rev-parse ${shq(b.branch ? `refs/heads/${b.branch}` : "HEAD")} 2>/dev/null || true`, "Reading the copy");
  await inGuest(g, [
    `cd ${shq(where)}`,
    `git fetch -q --force ${shq(`${WORK}/.in/${name}.bundle`)} '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'`,
    // the person's branches follow the checkout; the desktop's own, and the one checked out, don't move
    `cur=$(git symbolic-ref --short -q HEAD || true)`,
    `git for-each-ref --format='%(refname:strip=3)' refs/remotes/origin | grep -vx HEAD | while read -r br; do case "$br" in desktop/*|"$cur") ;; *) git update-ref "refs/heads/$br" "refs/remotes/origin/$br" ;; esac; done`,
  ].join("\n"), `Syncing ${name}`);
  return { from, to: b.head, bytes: data.length };
}

export interface ProjectState {
  project: string; branch: string; head: string;
  status: { count: number; files: string[] };
  stashes: string[]; worktrees: string[]; remotes: string[]; tags: string[]; log: string[];
}

/** The person's real checkout, read by host git: what a question about it is answered from. */
export async function projectState(ws: Workspace, name: string): Promise<ProjectState> {
  const home = project(ws, name);
  const lines = async (...args: string[]) => (await git(ws, home, ...args)).out.split("\n").map(l => l.trimEnd()).filter(Boolean);
  const status = await lines("status", "--porcelain");
  return {
    project: name,
    branch: (await git(ws, home, "symbolic-ref", "--short", "-q", "HEAD")).out.trim() || "(detached)",
    head: (await git(ws, home, "rev-parse", "HEAD")).out.trim(),
    status: { count: status.length, files: status.slice(0, 200) },
    stashes: (await lines("stash", "list")).slice(0, 50),
    worktrees: await lines("worktree", "list"),
    remotes: await lines("remote", "-v"),
    tags: (await lines("tag", "--sort=-creatordate")).slice(0, 50),
    log: await lines("log", "-20", "--format=%h %ad %s", "--date=short"),
  };
}

/** How far the checkout has moved since a copy was taken: commits on the person's branch since `base`. */
export async function ahead(ws: Workspace, name: string, base: string): Promise<number> {
  const r = await git(ws, project(ws, name), "rev-list", "--count", `${base}..HEAD`);
  return Number(r.out.trim()) || 0;
}
