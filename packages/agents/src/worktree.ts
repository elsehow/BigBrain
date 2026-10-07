/**
 * worktree.ts — a desktop's own copy of a project, when its agent asks for one.
 *
 * Agents work in the person's projects in place by default, seeing exactly
 * what the person sees. When one starts work that should be kept apart, it
 * calls start_work: a `git worktree add` from the project's own repo, on
 * branch `desktop/<id>`. A worktree shares the repo's database, so branches,
 * stashes, tags, remotes and other worktrees are the same facts on both
 * sides, and the person sees the desktop's branch in their own repo.
 *
 * A fresh worktree lacks what git ignores, so the dependency folders and env
 * files it needs to run (node_modules, .venv, .env…, at any depth) are
 * cloned from the project (APFS `cp -c`, which shares storage until a file
 * changes). A cloned virtualenv's scripts name their interpreter by absolute
 * path, so those first lines are rewritten to the worktree's own.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { run } from "./run";
import { AgentsError, checkDesktopId, listProjects, stateFolder, type Workspace } from "./workspace";

export interface WorkRecord { project: string; path: string; branch: string; base: string; created: string; ms: number; cloned: string[] }
export type LandHow = "pr" | "branch" | "auto";
export type Landed = { how: "branch"; branch: string; home: string } | { how: "pr"; branch: string; url: string };

/** What a worktree needs from the project to run: ignored dependency folders and env files. */
const ENV_NAMES = new Set(["node_modules", ".venv", "venv", ".env", ".env.local", ".envrc"]);

const git = async (ws: Workspace, cwd: string, ...args: string[]) => {
  const r = await run("git", args, cwd, ws.env?.());
  if (r.code !== 0) throw new AgentsError(`git ${args.join(" ")}: ${(r.err || r.out).trim()}`);
  return r.out.trim();
};
const homeOf = (ws: Workspace, name: string): string => {
  if (!listProjects(ws).some(p => p.name === name)) throw new AgentsError(`There is no project called ${name} in ${ws.projects}.`);
  return realpathSync(join(ws.projects, name));
};
const recordFile = (ws: Workspace, id: string, name: string) => join(stateFolder(ws, id), "work", `${name}.json`);
export const worktreePath = (ws: Workspace, id: string, name: string) => join(ws.desktops, checkDesktopId(id), name);

export function readWork(ws: Workspace, id: string, name: string): WorkRecord | undefined {
  const f = recordFile(ws, id, name);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) as WorkRecord : undefined;
}
export function listWork(ws: Workspace, id: string): WorkRecord[] {
  const dir = join(stateFolder(ws, id), "work");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".json")).map(f => JSON.parse(readFileSync(join(dir, f), "utf8")) as WorkRecord)
    .filter(r => existsSync(r.path)).sort((a, b) => a.project.localeCompare(b.project));
}

const inFlight = new Map<string, Promise<WorkRecord>>();

/** Give a desktop its own worktree of a project; one it already has returns its record. */
export function startWork(ws: Workspace, id: string, name: string): Promise<WorkRecord> {
  const key = `${id}/${name}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = doStart(ws, id, name).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

async function doStart(ws: Workspace, id: string, name: string): Promise<WorkRecord> {
  const known = readWork(ws, id, name);
  if (known && existsSync(known.path)) return known;
  const home = homeOf(ws, name);
  const path = worktreePath(ws, id, name);
  if (existsSync(path)) throw new AgentsError(`${path} already exists and isn't this desktop's worktree; move it aside first.`);
  const started = performance.now();
  await git(ws, home, "rev-parse", "--git-dir").catch(() => { throw new AgentsError(`${name} is not a git repository.`); });
  const base = await git(ws, home, "rev-parse", "HEAD");
  const branch = `desktop/${id}`;
  const exists = (await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], home, ws.env?.())).code === 0;
  mkdirSync(dirname(path), { recursive: true });
  await git(ws, home, "worktree", "add", "--quiet", ...(exists ? [path, branch] : ["-b", branch, path]));

  // Bring what git ignores but the project needs to run.
  const ignored = (await run("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], home, ws.env?.())).out
    .split("\n").map(l => l.replace(/\/$/, "")).filter(l => l && ENV_NAMES.has(basename(l)) && !l.includes(".claude/worktrees"));
  const cloned: string[] = [];
  for (const rel of ignored) {
    const from = join(home, rel), to = join(path, rel);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    const cp = await run("cp", ["-c", "-R", from, to], undefined, ws.env?.());
    if (cp.code !== 0) await run("cp", ["-R", from, to], undefined, ws.env?.()); // not APFS: a plain copy
    cloned.push(rel);
  }
  for (const rel of cloned) if (/(^|\/)(\.venv|venv)$/.test(rel)) rewriteVenv(join(path, rel), join(home, rel));

  const record: WorkRecord = { project: name, path, branch, base, created: new Date().toISOString(), ms: Math.round(performance.now() - started), cloned };
  mkdirSync(dirname(recordFile(ws, id, name)), { recursive: true });
  writeFileSync(recordFile(ws, id, name), JSON.stringify(record, null, 2));
  return record;
}

/** Point a cloned virtualenv's scripts at its own interpreter. Only shebangs
 * that resolve into the original venv are touched. */
export function rewriteVenv(venv: string, original: string): number {
  const bin = join(venv, "bin");
  if (!existsSync(join(venv, "pyvenv.cfg")) || !existsSync(bin)) return 0;
  const originalBin = realpathSync(join(original, "bin"));
  let rewritten = 0;
  for (const entry of readdirSync(bin, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(bin, entry.name);
    const body = readFileSync(file);
    const line = body.subarray(0, 4096).toString("utf8").split("\n", 1)[0]!;
    const match = /^#!(\S+)\/(python[\w.]*)(.*)$/.exec(line);
    if (!match) continue;
    try { if (realpathSync(match[1]!) !== originalBin) continue; } catch { continue; }
    writeFileSync(file, Buffer.concat([Buffer.from(`#!${bin}/${match[2]}${match[3]}`), body.subarray(Buffer.byteLength(line))]));
    rewritten++;
  }
  return rewritten;
}

/** Bring a worktree's committed work home. Its branch already lives in the
 * project's repo, so "as a branch" just confirms it; on GitHub (or with
 * `how: "pr"`) the branch is pushed and a pull request opened. Uncommitted
 * work and an empty branch are refused with the reason. */
export async function landWork(ws: Workspace, id: string, name: string, how: LandHow = "auto"): Promise<Landed> {
  const rec = readWork(ws, id, name);
  if (!rec || !existsSync(rec.path)) throw new AgentsError(`Desktop ${id} has no work of its own in ${name}; anything it changed in place is already in your copy.`);
  const dirty = (await git(ws, rec.path, "status", "--porcelain")).split("\n").filter(Boolean).length;
  if (dirty) throw new AgentsError(`${name} has ${dirty} uncommitted file${dirty === 1 ? "" : "s"} in desktop ${id}'s worktree. Commit them first; landing only moves commits.`);
  const commits = Number(await git(ws, rec.path, "rev-list", "--count", `${rec.base}..HEAD`));
  if (!commits) throw new AgentsError(`${name} has no commits on ${rec.branch} yet; there's nothing to land.`);
  const remote = (await run("git", ["remote", "get-url", "origin"], rec.path, ws.env?.())).out.trim();
  if (!(how === "pr" || (how === "auto" && /github\.com[:/]/.test(remote)))) return { how: "branch", branch: rec.branch, home: homeOf(ws, name) };
  if (!remote) throw new AgentsError(`${name} has no origin remote to open a pull request on. Its branch ${rec.branch} is already in your repo.`);
  await git(ws, rec.path, "push", "--quiet", "-u", "origin", rec.branch);
  const created = await run("gh", ["pr", "create", "--head", rec.branch, "--fill"], rec.path, ws.env?.());
  if (created.code === 0) return { how: "pr", branch: rec.branch, url: created.out.trim().split("\n").at(-1)! };
  const existing = await run("gh", ["pr", "view", rec.branch, "--json", "url", "--jq", ".url"], rec.path, ws.env?.());
  if (existing.code === 0 && existing.out.trim()) return { how: "pr", branch: rec.branch, url: existing.out.trim() };
  throw new AgentsError(`Pushed ${rec.branch}, but couldn't open a pull request: ${(created.err || created.out).trim()}`);
}

/** Delete a desktop's worktree of a project and its branch. */
export async function discardWork(ws: Workspace, id: string, name: string): Promise<void> {
  const rec = readWork(ws, id, name);
  if (!rec) return;
  const home = homeOf(ws, name);
  if (existsSync(rec.path)) await git(ws, home, "worktree", "remove", "--force", rec.path);
  await run("git", ["branch", "-D", rec.branch], home, ws.env?.());
  rmSync(recordFile(ws, id, name), { force: true });
}
