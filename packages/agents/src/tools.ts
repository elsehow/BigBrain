/**
 * tools.ts — the coding tools a desktop's agent works with.
 *
 * Paths are relative to the desktop's folder, where every project appears
 * under its own name. Reading goes through the links to home copies freely.
 * The first `write`, `edit` or `bash` that touches a project forks it
 * (fork.ts), so the change lands in the desktop's own copy at the same path.
 * Commands run in Harbor (harbor.ts). Every result carries a plain-language
 * label for the desktop's activity line.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { forkProject, type ForkRecord } from "./fork";
import { run } from "./run";
import type { Harbor } from "./harbor";
import { AgentsError, listProjects, projectState, type Workspace } from "./workspace";

export interface ToolResult { text: string; label: string; ok: boolean }
export interface AgentTool {
  name: string; description: string; parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
}
export interface ToolContext {
  ws: Workspace; desktop: string; folder: string; harbor: Harbor;
  forked(record: ForkRecord): void;
  server(port: number, job: number, command: string): void;
  homeCopyChanged(project: string, files: number): void;
}

const READ_LINES = 2000, READ_CHARS = 60_000, OUTPUT_CHARS = 30_000;
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new AgentsError(`Give ${what}.`);
  return v;
};

/** A path inside the desktop's folder, and the project it falls in, if any. */
function locate(ctx: ToolContext, path: string): { abs: string; rel: string; project?: string } {
  const abs = resolve(ctx.folder, path);
  if (!(abs === ctx.folder || abs.startsWith(ctx.folder + sep)))
    throw new AgentsError(`${path} is outside your folder. Paths are relative to it, and projects appear in it by name.`);
  const rel = relative(ctx.folder, abs);
  const first = rel.split(sep)[0]!;
  const project = listProjects(ctx.ws).some(p => p.name === first) ? first : undefined;
  return { abs, rel: rel || ".", ...(project ? { project } : {}) };
}

async function ensureFork(ctx: ToolContext, project: string): Promise<void> {
  if (projectState(ctx.ws, ctx.desktop, project) !== "link") return;
  ctx.forked(await forkProject(ctx.ws, ctx.desktop, project));
}

/** Projects a shell command touches: its working folder, and any path in it starting with a project's name. */
export function projectsIn(command: string, cwdRel: string, names: string[]): string[] {
  const found = new Set<string>();
  const first = cwdRel.split(sep)[0];
  if (first && names.includes(first)) found.add(first);
  for (const token of command.split(/[\s;&|()<>"'`=]+/)) {
    const seg = token.replace(/^\.\//, "").split("/")[0];
    if (seg && names.includes(seg)) found.add(seg);
  }
  return [...found];
}

async function dirtyCount(path: string): Promise<number> {
  const r = await run("git", ["status", "--porcelain"], path);
  return r.code === 0 ? r.out.split("\n").filter(Boolean).length : 0;
}

export function codingTools(ctx: ToolContext): AgentTool[] {
  return [
    {
      name: "read", description: "Read a file. Paths are relative to your folder, where each project appears by name. Returns numbered lines; use offset and limit for long files.",
      parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false },
      async run(a) {
        const { abs, rel } = locate(ctx, str(a.path, "a path"));
        if (!existsSync(abs)) throw new AgentsError(`${rel} doesn't exist.`);
        if (statSync(abs).isDirectory()) throw new AgentsError(`${rel} is a folder; use ls.`);
        const lines = readFileSync(abs, "utf8").split("\n");
        const from = Math.max(1, Number(a.offset) || 1), count = Math.min(READ_LINES, Number(a.limit) || READ_LINES);
        let text = lines.slice(from - 1, from - 1 + count).map((l, i) => `${from + i}\t${l}`).join("\n");
        if (text.length > READ_CHARS) text = text.slice(0, READ_CHARS) + "\n… (cut; read a smaller window)";
        const more = from - 1 + count < lines.length ? `\n… ${lines.length - (from - 1 + count)} more lines` : "";
        return { text: text + more, label: `Read ${rel}`, ok: true };
      },
    },
    {
      name: "ls", description: "List a folder. Your folder lists every project: forked ones are your own copies; the rest are your person's home copies, readable until you change them.",
      parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
      async run(a) {
        const { abs, rel } = locate(ctx, typeof a.path === "string" && a.path ? a.path : ".");
        const names = readdirSync(abs, { withFileTypes: true }).filter(e => e.name !== ".git").map(e => {
          if (abs === ctx.folder && listProjects(ctx.ws).some(p => p.name === e.name))
            return `${e.name}/  (${projectState(ctx.ws, ctx.desktop, e.name) === "fork" ? "your fork" : "home copy: forked on your first change"})`;
          return e.isDirectory() || e.isSymbolicLink() ? `${e.name}/` : e.name;
        }).sort();
        return { text: names.join("\n") || "(empty)", label: `Listed ${rel}`, ok: true };
      },
    },
    {
      name: "write", description: "Create or replace a file. Writing into a project forks it first, so the change lands in your own copy at the same path.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
      async run(a) {
        const where = locate(ctx, str(a.path, "a path"));
        if (typeof a.content !== "string") throw new AgentsError("Give the file's content.");
        if (where.project) await ensureFork(ctx, where.project);
        mkdirSync(dirname(where.abs), { recursive: true });
        writeFileSync(where.abs, a.content);
        return { text: `Wrote ${where.rel} (${a.content.length} characters).`, label: `Wrote ${where.rel}`, ok: true };
      },
    },
    {
      name: "edit", description: "Replace exact text in a file. old must match exactly once unless all is true. Editing a project forks it first.",
      parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" }, all: { type: "boolean" } }, required: ["path", "old", "new"], additionalProperties: false },
      async run(a) {
        const where = locate(ctx, str(a.path, "a path"));
        const oldText = str(a.old, "the exact text to replace");
        if (typeof a.new !== "string") throw new AgentsError("Give the replacement text.");
        if (!existsSync(where.abs)) throw new AgentsError(`${where.rel} doesn't exist.`);
        if (where.project) await ensureFork(ctx, where.project);
        const body = readFileSync(where.abs, "utf8");
        const count = body.split(oldText).length - 1;
        if (!count) throw new AgentsError(`That text isn't in ${where.rel}. Read the file again; it may have changed.`);
        if (count > 1 && a.all !== true) throw new AgentsError(`That text appears ${count} times in ${where.rel}; include more context, or set all.`);
        writeFileSync(where.abs, a.all === true ? body.split(oldText).join(a.new) : body.replace(oldText, () => a.new as string));
        const n = a.all === true ? count : 1;
        return { text: `Edited ${where.rel} (${n} replacement${n === 1 ? "" : "s"}).`, label: `Edited ${where.rel}`, ok: true };
      },
    },
    {
      name: "bash", description: "Run a shell command in your folder (or cwd inside it). A command that touches a project forks it first. Long-running commands such as dev servers return on their own once they're listening, and keep running.",
      parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"], additionalProperties: false },
      async run(a, signal) {
        const command = str(a.command, "a command");
        const where = locate(ctx, typeof a.cwd === "string" && a.cwd ? a.cwd : ".");
        const names = listProjects(ctx.ws).map(p => p.name);
        for (const p of projectsIn(command, where.rel === "." ? "" : where.rel, names)) await ensureFork(ctx, p);
        // A command can still reach a home copy through its link (or any path):
        // that isn't a boundary, so it is watched and reported instead.
        const linked = names.filter(n => projectState(ctx.ws, ctx.desktop, n) === "link").slice(0, 12);
        const before = new Map(await Promise.all(linked.map(async n => [n, await dirtyCount(join(ctx.ws.projects, n))] as const)));
        const result = await ctx.harbor.run(ctx.desktop, command, where.abs, signal);
        for (const n of linked) {
          const after = await dirtyCount(join(ctx.ws.projects, n));
          if (after !== before.get(n)) ctx.homeCopyChanged(n, after);
        }
        const short = command.length > 60 ? command.slice(0, 57) + "…" : command;
        const tail = (s: string) => s.length > OUTPUT_CHARS ? "… (earlier output cut)\n" + s.slice(-OUTPUT_CHARS) : s;
        if (result.status === "exited") {
          const ok = result.code === 0;
          // A fixed-port server that collides names who holds the port.
          const busy = /EADDRINUSE[^\n]*?:(\d+)/.exec(result.output);
          const holder = busy ? await ctx.harbor.holder(Number(busy[1])) : undefined;
          const note = busy ? `\n[Port ${busy[1]} is in use${holder ? holder === ctx.desktop ? " by another of your own commands" : ` by desktop ${holder}` : " by a process outside any desktop"}.]` : "";
          return { text: `${tail(result.output) || "(no output)"}\n[exit ${result.code ?? result.signal}]${note}`, label: `Ran ${short}${ok ? "" : ` (exit ${result.code ?? result.signal})`}`, ok };
        }
        for (const port of result.ports) ctx.server(port, result.job, command);
        const label = result.ports.length ? `Started ${short} on :${result.ports.join(", :")}` : `Still running ${short}`;
        return { text: `${tail(result.output)}\n[${result.note}]`, label, ok: true };
      },
    },
  ];
}
