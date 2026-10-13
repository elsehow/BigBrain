/**
 * review.ts — bringing a contained desktop's work home (the plan's "Land",
 * I7 and I8).
 *
 * Review: the guest bundles the desktop's branch, less what the person
 * already has; the host reads the bundle to a file of its own, verifies it
 * and fetches it, with every object checked (fetch.fsckObjects), into a bare
 * review repo it owns under the desktop's state folder. That repo borrows
 * the project's objects (objects/info/alternates), so the bundle's basis
 * resolves and only new objects land. The commits and diff the person sees
 * are computed there by host git, never by the machine.
 *
 * Land: exactly the reviewed commit, from the review repo, into the
 * person's repo as desktop/<id>; then, on GitHub (or when asked), pushed
 * and opened as a pull request, with the person's credentials, on the host.
 * A commit the agent made after the review isn't in the review repo's
 * branch, so it doesn't land.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Guest } from "./guest";
import { WORK, type CopyRecord } from "./projects";
import { run } from "./run";
import { publish, type LandHow, type Landed, type WorkDiff } from "./worktree";
import { AgentsError, checkDesktopId, listProjects, stateFolder, type Workspace } from "./workspace";

const DIFF_CHARS = 200_000;
const BUNDLE_MAX = 256 * 1024 * 1024;

/** What Land would bring home from a copy, and the files it touches (for the host's flags). */
export interface CopyDiff extends WorkDiff { files: string[]; dirty: number }

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const git = async (ws: Workspace, cwd: string, ...args: string[]) => {
  const r = await run("git", args, cwd, ws.env?.());
  if (r.code !== 0) throw new AgentsError(`git ${args[0]}: ${(r.err || r.out).trim().slice(0, 300)}`);
  return r.out.trim();
};

function home(ws: Workspace, name: string): string {
  const p = listProjects(ws).find(x => x.name === name);
  if (!p) throw new AgentsError(`There is no project called ${name}.`);
  return p.path;
}

// ── a desktop's copies, as the host records them ────────────────────────────
const copyFile = (ws: Workspace, id: string, name: string) => join(stateFolder(ws, checkDesktopId(id)), "copies", `${name}.json`);

export function saveCopy(ws: Workspace, id: string, r: CopyRecord): void {
  const f = copyFile(ws, id, r.project);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify(r, null, 2));
}
export function readCopy(ws: Workspace, id: string, name: string): CopyRecord | undefined {
  const f = copyFile(ws, id, name);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) as CopyRecord : undefined;
}
export function listCopies(ws: Workspace, id: string): CopyRecord[] {
  const dir = join(stateFolder(ws, checkDesktopId(id)), "copies");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(join(dir, f), "utf8")) as CopyRecord).sort((a, b) => a.project.localeCompare(b.project));
}

/** The review repo for a desktop's copy of a project: bare, host-owned, borrowing the project's objects, checking every object it receives. */
async function reviewRepo(ws: Workspace, id: string, name: string): Promise<string> {
  const repo = join(stateFolder(ws, checkDesktopId(id)), "review", `${name}.git`);
  if (!existsSync(join(repo, "HEAD"))) {
    mkdirSync(repo, { recursive: true });
    // no template: no sample hooks, nothing but what git needs
    await git(ws, repo, "init", "--quiet", "--bare", "--template=");
    for (const [k, v] of [["fetch.fsckObjects", "true"], ["transfer.fsckObjects", "true"], ["core.hooksPath", "/dev/null"], ["gc.auto", "0"]]) await git(ws, repo, "config", k!, v!);
  }
  // the project's own objects, wherever its repo keeps them (a worktree's common dir)
  const common = resolve(home(ws, name), await git(ws, home(ws, name), "rev-parse", "--git-common-dir"));
  mkdirSync(join(repo, "objects", "info"), { recursive: true });
  writeFileSync(join(repo, "objects", "info", "alternates"), `${join(common, "objects")}\n`);
  return repo;
}

/** Fetch the desktop's branch from its machine into the review repo, and say what landing it would bring home. */
export async function copyDiff(ws: Workspace, id: string, name: string, g: Guest): Promise<CopyDiff> {
  const copy = readCopy(ws, id, name);
  if (!copy) throw new AgentsError(`Desktop ${id} hasn't opened ${name}.`);
  const branch = copy.desktopBranch;
  const where = `${WORK}/${name}`;
  // in the machine: what's uncommitted, and a bundle of the branch less the person's
  let said = "";
  const x = await g.exec(["/bin/bash", "-c", [
    "set -e", `cd ${shq(where)}`,
    "git status --porcelain | wc -l",
    `rm -f ${shq(`${WORK}/.out/${name}.bundle`)}`, `mkdir -p ${shq(`${WORK}/.out`)}`,
    `if [ "$(git rev-list --count ${shq(branch)} --not --remotes=origin)" = 0 ]; then echo empty; else git bundle create -q ${shq(`${WORK}/.out/${name}.bundle`)} ${shq(branch)} --not --remotes=origin; echo made; fi`,
  ].join("\n")], { cwd: WORK }, (_k, d) => { said += d; });
  const exit = await x.exit;
  if (exit.code !== 0) throw new AgentsError(`Couldn't read ${name}'s copy in the machine: ${said.trim().slice(-300)}`);
  const [dirtyLine = "0", made = "empty"] = said.trim().split("\n");
  const dirty = Number(dirtyLine) || 0;
  const repo = await reviewRepo(ws, id, name);
  const personHead = await git(ws, home(ws, name), "rev-parse", "HEAD");
  const empty: CopyDiff = { project: name, branch, base: personHead, head: personHead, commits: [], stat: "", patch: "", cut: false, files: [], dirty };
  if (made !== "made") {
    // nothing of its own: nothing stale may stay reviewable
    await run("git", ["update-ref", "-d", `refs/heads/${branch}`], repo, ws.env?.());
    return empty;
  }
  const got = await g.read(`${WORK}/.out/${name}.bundle`, { length: BUNDLE_MAX });
  if (got.data.length < got.size) throw new AgentsError(`${name}'s new work is over ${BUNDLE_MAX / 2 ** 20} MiB, too large to bring home this way.`);
  const out = join(stateFolder(ws, id), "out");
  mkdirSync(out, { recursive: true });
  const file = join(out, `${name}.bundle`);
  writeFileSync(file, got.data);
  // the bundle's basis must be the person's, and every object must check out
  await git(ws, repo, "bundle", "verify", "-q", file).catch(e => { throw new AgentsError(`${name}'s bundle from the machine doesn't verify against your repo: ${(e as Error).message}`); });
  await git(ws, repo, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", file, `+refs/heads/${branch}:refs/heads/${branch}`);
  const head = await git(ws, repo, "rev-parse", `refs/heads/${branch}`);
  const base = await git(ws, repo, "merge-base", head, personHead).catch(() => personHead);
  const commits = (await git(ws, repo, "log", "--format=%h%x09%s", `${base}..${head}`)).split("\n").filter(Boolean)
    .map(l => { const [hash = "", ...subject] = l.split("\t"); return { hash, subject: subject.join("\t") }; });
  const flags = ["--no-ext-diff", "--no-textconv"];
  const stat = await git(ws, repo, "diff", ...flags, "--stat", base, head);
  const files = (await git(ws, repo, "diff", ...flags, "--name-only", base, head)).split("\n").filter(Boolean);
  const patch = (await run("git", ["diff", "--no-color", ...flags, base, head], repo, ws.env?.())).out;
  return { project: name, branch, base, head, commits, stat, patch: patch.slice(0, DIFF_CHARS), cut: patch.length > DIFF_CHARS, files, dirty };
}

/** Land the commit the person reviewed: from the review repo into their repo as desktop/<id>, then a pull request where the project is on GitHub. */
export async function landCopy(ws: Workspace, id: string, name: string, how: LandHow, reviewed: string): Promise<Landed> {
  const copy = readCopy(ws, id, name);
  if (!copy) throw new AgentsError(`Desktop ${id} hasn't opened ${name}.`);
  const branch = copy.desktopBranch;
  const repo = join(stateFolder(ws, checkDesktopId(id)), "review", `${name}.git`);
  const tip = (await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo, ws.env?.())).out.trim();
  if (!tip) throw new AgentsError(`There's nothing reviewed to land from ${name}. Review it first.`);
  if (tip !== reviewed) throw new AgentsError(`${name} has changed since you reviewed it. Review it again before landing.`);
  const project = home(ws, name);
  // exactly the reviewed commit, from the host's own review repo
  await git(ws, project, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", repo, `+refs/heads/${branch}:refs/heads/${branch}`);
  const landed = await git(ws, project, "rev-parse", `refs/heads/${branch}`);
  if (landed !== reviewed) throw new AgentsError(`${name}'s ${branch} isn't what you reviewed after landing; nothing was pushed.`);
  return publish(ws, project, name, branch, reviewed, how);
}

/** Discard a desktop's copy of a project: its review repo and bundles here, and the copy in its machine when it's given. */
export async function discardCopy(ws: Workspace, id: string, name: string, g?: Guest): Promise<void> {
  const state = stateFolder(ws, checkDesktopId(id));
  rmSync(join(state, "review", `${name}.git`), { recursive: true, force: true });
  rmSync(join(state, "out", `${name}.bundle`), { force: true });
  rmSync(join(state, "in", `${name}.bundle`), { force: true });
  rmSync(copyFile(ws, id, name), { force: true });
  if (g) {
    const x = await g.exec(["/bin/rm", "-rf", `${WORK}/${name}`, `${WORK}/.in/${name}.bundle`, `${WORK}/.out/${name}.bundle`], { cwd: WORK }, () => {});
    await x.exit;
  }
}
