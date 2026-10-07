/** run.ts — run a program to completion and collect its output. */
import { spawn } from "node:child_process";

/** Always with a named environment: given none, a spawn inherits the one this
 * process started with, whatever has been taken out of process.env since. */
export function run(cmd: string, args: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", fail);
    child.on("close", code => done({ code: code ?? 1, out, err }));
  });
}
