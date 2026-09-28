/** Pi's standard editing tools, with every filesystem operation behind the OS sandbox. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createReadTool, createWriteTool, createEditTool, createBashTool, createLsTool, createFindTool } from "@earendil-works/pi-coding-agent";
import { rgPath } from "@vscode/ripgrep";
import { WorkerSandbox, shellQuote, type WorkerScope } from "./sandbox";
import type { RunTool } from "../run/machineTools";
const fileOperation = `
const fs = require('node:fs');
const a = JSON.parse(await Bun.stdin.text());
let result;
function regular(path) { const s=fs.statSync(path); if(!s.isFile() || s.nlink !== 1 || s.size > 1000000) throw Error('Use a regular, unlinked file under 1 MB'); }
switch(a.op) {
case 'read': regular(a.path); result=fs.readFileSync(a.path).toString('base64'); break;
case 'write': if(fs.existsSync(a.path)) regular(a.path); if(typeof a.content!=='string'||a.content.length>1000000)throw Error('File content too large'); fs.writeFileSync(a.path,a.content); break;
case 'mkdir': if(!fs.existsSync(a.path)) fs.mkdirSync(a.path,{recursive:true}); break;
case 'access': fs.accessSync(a.path); regular(a.path); break;
case 'exists': result=fs.existsSync(a.path); break;
case 'stat': result=fs.statSync(a.path).isDirectory(); break;
case 'readdir': result=fs.readdirSync(a.path); break;
default: throw Error('Unknown file operation');
}
process.stdout.write(JSON.stringify(result??null));`;
export function workerTools(scope: WorkerScope, sandbox: WorkerSandbox): RunTool[] {
  const active = new AsyncLocalStorage<AbortSignal>();
  const signal = () => { const s = active.getStore(); if (!s) throw new Error("No active worker tool call."); s.throwIfAborted(); return s; };
  const fs = async (op: string, path: string, content?: string): Promise<any> => {
    const result = await sandbox.run(`${shellQuote(process.execPath)} -e ${shellQuote(fileOperation)}`, signal(), JSON.stringify({ op, path, content }));
    signal().throwIfAborted();
    if (result.exitCode !== 0) throw new Error(result.stderr.slice(-4000) || "Sandbox denied the file operation.");
    return JSON.parse(result.stdout);
  };
  const readFile = async (path: string) => Buffer.from(await fs("read", path), "base64");
  const writeFile = async (path: string, content: string) => { await fs("write", path, content); };
  const access = async (path: string) => { await fs("access", path); };
  const tools = [
    createReadTool(scope.project, { autoResizeImages: false, operations: { readFile, access, detectImageMimeType: async () => null } }),
    createWriteTool(scope.project, { operations: { writeFile, mkdir: async path => { await fs("mkdir", path); } } }),
    createEditTool(scope.project, { operations: { readFile, writeFile, access } }),
    createLsTool(scope.project, { operations: { exists: path => fs("exists", path), readdir: path => fs("readdir", path), stat: async path => { const dir = await fs("stat", path); return { isDirectory: () => dir }; } } }),
    createFindTool(scope.project, { operations: { exists: path => fs("exists", path), glob: async (pattern, cwd, options) => {
      const result = await sandbox.run([rgPath, "--files", "--hidden", "-g", pattern, ...options.ignore.flatMap(p => ["-g", "!" + p]), cwd].map(shellQuote).join(" "), signal());
      signal().throwIfAborted();
      if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr.slice(-4000) || "Sandbox denied file search.");
      return result.stdout.trim().split("\n").filter(Boolean).slice(0, Math.min(options.limit, 2500));
    } } }),
    ...(scope.mode === "work" ? [createBashTool(scope.project, { exposeSessionEnvironment: false, operations: { exec: async (command, _cwd, options) => {
      const result = await sandbox.run(command, signal(), undefined, (options.timeout ?? 120) * 1000);
      signal().throwIfAborted(); options.onData(Buffer.from(result.stdout + result.stderr)); return { exitCode: result.exitCode };
    } } })] : []),
  ];
  return tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters as unknown as Record<string, unknown>,
    call: (args: Record<string, unknown>) => {
      // The signal is supplied by the host wrapper, never taken from model arguments.
      const s = currentWorkerSignal.getStore(); if (!s) throw new Error("No active worker turn.");
      return active.run(s, () => tool.execute(crypto.randomUUID(), args as never, s));
    } }));
}
/** Scope cancellation around host dispatch; not part of the model-visible schema. */
export const currentWorkerSignal = new AsyncLocalStorage<AbortSignal>();
