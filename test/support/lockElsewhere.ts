/** lockElsewhere.ts — another process taking a lock through the engine's own
 * call and holding it until killed: what a second run sees of a first. */
import { expect } from "bun:test";
import { join } from "node:path";

export interface Elsewhere { pid: number; kill(): Promise<void> }

/** Spawn a process that imports lib/`module`, calls `fn(...args)` and holds
 * what it returns until killed (SIGKILL: no chance to let anything go). */
export async function holdElsewhere(module: string, fn: string, args: unknown[]): Promise<Elsewhere> {
  const child = Bun.spawn([process.execPath, "-e", `const m = await import(process.env.MODULE);
    const hold = await m[process.env.FN](...JSON.parse(process.env.ARGS));
    console.log(hold ? "held" : "busy");
    setInterval(() => {}, 60_000); // holds until killed`], {
    env: { ...process.env, MODULE: join(import.meta.dir, "../../lib", module), FN: fn, ARGS: JSON.stringify(args) },
    stdout: "pipe", stderr: "inherit",
  });
  const kill = async (): Promise<void> => { child.kill(9); await child.exited; };
  const said = new TextDecoder().decode((await child.stdout.getReader().read()).value);
  if (!said.includes("held")) await kill();
  expect(said).toContain("held");
  return { pid: child.pid, kill };
}
