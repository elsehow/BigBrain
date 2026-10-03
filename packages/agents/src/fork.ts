/**
 * fork.ts — a desktop's own copy of a project.
 *
 * A fork is an APFS clone (`cp -c -R`) of the project's home copy: the whole
 * folder, environment included (node_modules, .venv, .env, build output),
 * sharing storage until a file changes. It is a complete repo on its own
 * branch, `desktop/<id>`, so nothing is redirected and no setup step runs.
 *
 * Three mechanical adjustments keep it honest:
 * - other sessions' worktrees nested in the home copy are not carried over,
 *   and neither is git's record of them (`.git/worktrees`);
 * - a virtualenv's scripts name their interpreter by absolute path, so the
 *   first line of each is rewritten to the fork's own interpreter;
 * - a home copy that is itself a linked worktree (`.git` is a file) is
 *   refused: its fork would share the other repo's git directory.
 */
import { run } from "./run";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { AgentsError, desktopFolder, projectState, stateFolder, type Workspace } from "./workspace";

export interface ForkRecord { project: string; path: string; branch: string; base: string; created: string; ms: number }

const git = async (cwd: string, ...args: string[]) => {
  const r = await run("git", args, cwd);
  if (r.code !== 0) throw new AgentsError(`git ${args.join(" ")} failed: ${(r.err || r.out).trim()}`);
  return r.out.trim();
};

const inFlight = new Map<string, Promise<ForkRecord>>();

/** Fork a project into a desktop's folder; a project already forked returns its record. */
export function forkProject(ws: Workspace, id: string, name: string): Promise<ForkRecord> {
  const key = `${id}/${name}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = doFork(ws, id, name).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

export function readFork(ws: Workspace, id: string, name: string): ForkRecord | undefined {
  const file = join(stateFolder(ws, id), "forks", `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as ForkRecord : undefined;
}

async function doFork(ws: Workspace, id: string, name: string): Promise<ForkRecord> {
  const desk = desktopFolder(ws, id);
  const target = join(desk, name);
  const state = projectState(ws, id, name);
  if (state === "absent") throw new AgentsError(`There is no project called ${name} in ${ws.projects}.`);
  if (state === "fork") {
    const known = readFork(ws, id, name);
    if (known) return known;
    throw new AgentsError(`${target} is a folder this package didn't make; move it aside first.`);
  }
  const home = realpathSync(join(ws.projects, name));
  const dotGit = join(home, ".git");
  if (!existsSync(dotGit)) throw new AgentsError(`${name} is not a git repository.`);
  if (!statSync(dotGit).isDirectory())
    throw new AgentsError(`${name} is a worktree of another repository. Add that repository's main checkout to the workspace instead.`);

  const started = performance.now();
  const base = await git(home, "rev-parse", "HEAD");
  const nested = (await git(home, "worktree", "list", "--porcelain"))
    .split("\n").filter(l => l.startsWith("worktree ")).map(l => l.slice(9))
    .map(p => { try { return realpathSync(p); } catch { return p; } })
    .filter(p => p !== home && p.startsWith(home + sep));

  const tmp = join(desk, `.${name}.forking-${crypto.randomUUID().slice(0, 8)}`);
  try {
    const cp = await run("cp", ["-c", "-R", home, tmp]);
    if (cp.code !== 0) throw new AgentsError(`Couldn't clone ${name}: ${cp.err.trim() || "cp failed"}. Forks need an APFS volume (cp -c).`);
    for (const p of nested) rmSync(join(tmp, relative(home, p)), { recursive: true, force: true });
    rmSync(join(tmp, ".git", "worktrees"), { recursive: true, force: true });
    rewriteVenvs(tmp, home, target);
    const branch = `desktop/${id}`;
    const exists = (await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], tmp)).code === 0;
    await git(tmp, "switch", ...(exists ? [branch] : ["-c", branch]));
    if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
    renameSync(tmp, target);
    const record: ForkRecord = { project: name, path: target, branch, base, created: new Date().toISOString(), ms: Math.round(performance.now() - started) };
    const forks = join(stateFolder(ws, id), "forks");
    rmSync(join(forks, `${name}.json`), { force: true });
    writeJson(join(forks, `${name}.json`), record);
    return record;
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

/** Point a cloned virtualenv's scripts at the fork's own interpreter. Only
 * shebangs that resolve into the home copy's venv are touched. */
export function rewriteVenvs(clone: string, home: string, finalPath: string): number {
  let rewritten = 0;
  for (const venv of [".venv", "venv", "env"]) {
    const bin = join(clone, venv, "bin");
    if (!existsSync(join(clone, venv, "pyvenv.cfg")) || !existsSync(bin)) continue;
    const homeBin = realpathSync(join(home, venv, "bin"));
    const finalBin = join(finalPath, venv, "bin");
    for (const entry of readdirSync(bin, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = join(bin, entry.name);
      const head = readFileSync(file).subarray(0, 4096).toString("utf8");
      if (!head.startsWith("#!")) continue;
      const line = head.split("\n", 1)[0]!;
      const match = /^#!(\S+)\/(python[\w.]*)(.*)$/.exec(line);
      if (!match) continue;
      let dir: string;
      try { dir = realpathSync(match[1]!); } catch { continue; }
      if (dir !== homeBin) continue;
      const body = readFileSync(file);
      writeFileSync(file, Buffer.concat([Buffer.from(`#!${finalBin}/${match[2]}${match[3]}`), body.subarray(Buffer.byteLength(line))]));
      rewritten++;
    }
  }
  return rewritten;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Delete a desktop's fork of a project and put the link back. */
export function discardFork(ws: Workspace, id: string, name: string): void {
  const target = join(desktopFolder(ws, id), name);
  if (projectState(ws, id, name) !== "fork") return;
  if (!readFork(ws, id, name)) throw new AgentsError(`${target} wasn't made by this package; not deleting it.`);
  rmSync(target, { recursive: true, force: true });
  rmSync(join(stateFolder(ws, id), "forks", `${name}.json`), { force: true });
  desktopFolder(ws, id);
}
