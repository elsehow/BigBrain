import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { spoolDir } from "../spool";
import { killGroup, workerEnvironment } from "./sandbox";
async function git(args: string[], home: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { env: { ...workerEnvironment(home), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const abort = () => { if (child.pid) killGroup(child.pid); };
    signal.addEventListener("abort", abort, { once: true });
    let output = ""; child.stdout.on("data", b => { output += b; }); child.stderr.resume();
    child.once("error", e => { signal.removeEventListener("abort", abort); reject(e); });
    child.once("close", code => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(signal.reason); else if (code) reject(new Error("Could not create the project's independent checkout.")); else resolve(output.trim()); });
  });
}
export async function workerWorkspace(root: string, id: string, path: string | undefined, mode: "read" | "work", signal: AbortSignal) {
  const base = join(spoolDir(root), "worker-workspaces", id), scratch = join(base, "scratch");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  if (!path) return { project: realpathSync(scratch), scratch: realpathSync(scratch), isolation: "scratch" as const };
  if (mode === "work" && existsSync(join(path, ".git"))) {
    const project = join(base, "checkout");
    // An independent clone avoids granting writes to a shared worktree's Git
    // metadata. Only committed HEAD is copied; never merge or publish here.
    if (!existsSync(project)) {
      await git(["clone", "--no-hardlinks", "--no-local", "--no-checkout", "--", path, project], scratch, signal);
      // Keep repository identity for normal CLI workflows (for example gh).
      // Never copy credentials embedded in a remote URL into the workspace.
      const remote = await git(["-C", path, "remote", "get-url", "origin"], scratch, signal).catch(() => "");
      if (remote.startsWith("https://")) {
        const url = new URL(remote);
        if (!url.username && !url.password) await git(["-C", project, "remote", "set-url", "origin", remote], scratch, signal);
      } else if (/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(remote)) await git(["-C", project, "remote", "set-url", "origin", remote], scratch, signal);
    }
    await git(["-C", project, "checkout", "--detach", "HEAD"], scratch, signal);
    return { project: realpathSync(project), scratch: realpathSync(scratch), isolation: "checkout" as const };
  }
  return { project: path, scratch: realpathSync(scratch), isolation: mode === "work" ? "direct" as const : "read" as const };
}
