/** Adapt legacy memory fixture scripts into calls to the real bounded memory tools.
 * Writes outside memory are concurrent host activity, never model authority. */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { memoryTreeFiles } from "../../lib/memoryTree";
import { writeAtomic } from "../../lib/fsx";
import { fakePi, type Options, type ModelAnswer } from "./pi";
export function fakeMemoryPi(answer: (prompt: string, options: Options) => ModelAnswer | Promise<ModelAnswer>) {
  return fakePi(async (prompt, options) => {
    const root = resolve(options.cwd!, "../../..");
    const snapshot = () => new Map(memoryTreeFiles(root).map(path => [`memory/${path}`, readFileSync(join(root, "memory", path), "utf8")]));
    const before = snapshot(); let result: ModelAnswer | undefined, failure: unknown;
    try { result = await answer(prompt, options); } catch (error) { failure = error; }
    const after = snapshot(), paths = new Set([...before.keys(), ...after.keys()]);
    for (const path of paths) {
      if (before.get(path) === after.get(path)) continue;
      if (before.has(path)) writeAtomic(join(root, path), before.get(path)!);
      else if (existsSync(join(root, path))) unlinkSync(join(root, path));
      const name = after.has(path) ? "write_memory" : "delete_memory";
      const tool = options.customTools!.find(t => t.name === name)!;
      if (!tool) throw new Error(`Fixture attempted ${name} without authority`);
      await tool.execute(crypto.randomUUID(), { path, ...(after.has(path) ? { content: after.get(path) } : {}) }, new AbortController().signal);
    }
    if (failure) throw failure;
    return result!;
  });
}
