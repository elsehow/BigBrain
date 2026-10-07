/**
 * tools.ts — the coding tools a desktop's agent works with.
 *
 * Paths are relative to the workspace root (workspace.ts): the person's
 * projects at projects/<name>, the desktop's own worktrees at
 * desktops/<id>/<name>. Nothing is redirected and no command is classified:
 * the agent works where it says it works. Editing a project in place takes
 * its lease; start_work gives the desktop its own worktree (worktree.ts).
 * Commands run in Harbor (harbor.ts). Every result carries a plain-language
 * label for the desktop's activity line.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Harbor } from "./harbor";
import { startWork, type WorkRecord } from "./worktree";
import { AgentsError, listProjects, takeLease, type Workspace } from "./workspace";

export interface ToolResult { text: string; label: string; ok: boolean }
export interface AgentTool {
  name: string; description: string; parameters: Record<string, unknown>;
  label?(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
}
export interface ToolContext {
  ws: Workspace; desktop: string; harbor: Harbor;
  started(record: WorkRecord): void;
  server(port: number, job: number, command: string): void;
  /** The host's word on a path outside the workspace (OpenOptions.elsewhere). */
  elsewhere?(path: string): string | undefined;
  /** The host's word on a shell command before it runs (OpenOptions.shell). */
  shell?(command: string): string | undefined;
  /** The host's word on a file write before it lands (OpenOptions.write). */
  write?(path: string): string | undefined;
  /** Told what a file held when the file tools read or wrote it (OpenOptions.file). */
  file?(how: "read" | "wrote", path: string, content: string): void | Promise<void>;
}

const READ_LINES = 2000, READ_CHARS = 60_000, OUTPUT_CHARS = 30_000;
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new AgentsError(`Give ${what}.`);
  return v;
};

/** A path in the agent's world (projects/ or this desktop's desktops/<id>/), and the in-place project it falls in, if any. */
function locate(ctx: ToolContext, path: string): { abs: string; rel: string; inPlace?: string } {
  const abs = resolve(ctx.ws.root, path);
  const mine = join(ctx.ws.desktops, ctx.desktop);
  const inside = (dir: string) => abs === dir || abs.startsWith(dir + sep);
  if (!inside(ctx.ws.projects) && !inside(mine) && abs !== ctx.ws.root)
    throw new AgentsError(ctx.elsewhere?.(path) ?? `${path} is outside your world: use projects/<name> for your person's projects and desktops/${ctx.desktop}/<name> for your own worktrees.`);
  const rel = relative(ctx.ws.root, abs) || ".";
  const first = inside(ctx.ws.projects) ? relative(ctx.ws.projects, abs).split(sep)[0] : undefined;
  return { abs, rel, ...(first && listProjects(ctx.ws).some(p => p.name === first) ? { inPlace: first } : {}) };
}

/** Where a write lands, links followed: the file's real path. Never inside a
 * repository's .git (its hooks and config run code), however the path is spelled or linked. */
function landing(abs: string, rel: string): string {
  let at = abs;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  // a broken link would be followed to wherever it names
  if (at !== abs && lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) throw new AgentsError(`${rel} is a broken link; the file tools don't write through it.`);
  const real = join(realpathSync(at), relative(at, abs));
  if ([rel, real].some(p => p.split(sep).some(s => s.toLowerCase() === ".git"))) throw new AgentsError(`${rel} is inside a .git folder; the file tools don't write there.`);
  return real;
}

/** The host's word on a write, before it lands. */
function mayWrite(ctx: ToolContext, real: string): void {
  const refused = ctx.write?.(real);
  if (refused) throw new AgentsError(refused);
}

/** Editing a project in place takes its lease; another desktop's lease means start_work instead. */
function lease(ctx: ToolContext, project: string | undefined): void {
  if (!project) return;
  const holder = takeLease(ctx.ws, ctx.desktop, project);
  if (holder) throw new AgentsError(`Desktop ${holder} is editing ${project} in place. Call start_work for ${project} to get your own worktree, and work there.`);
}

export function codingTools(ctx: ToolContext): AgentTool[] {
  const labelPath = (a: Record<string, unknown>) => typeof a.path === "string" && a.path ? a.path : "your workspace";
  return [
    {
      name: "read", description: "Read a file. Paths are relative to your workspace: projects/<name>/… are your person's projects; desktops/<id>/<name>/… are your own worktrees. Returns numbered lines; use offset and limit for long files.",
      parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false },
      label: a => `Reading ${labelPath(a)}`,
      async run(a) {
        const { abs, rel } = locate(ctx, str(a.path, "a path"));
        if (!existsSync(abs)) throw new AgentsError(`${rel} doesn't exist.`);
        if (statSync(abs).isDirectory()) throw new AgentsError(`${rel} is a folder; use ls.`);
        const body = readFileSync(abs, "utf8");
        await ctx.file?.("read", realpathSync(abs), body);
        const lines = body.split("\n");
        const from = Math.max(1, Number(a.offset) || 1), count = Math.min(READ_LINES, Number(a.limit) || READ_LINES);
        let text = lines.slice(from - 1, from - 1 + count).map((l, i) => `${from + i}\t${l}`).join("\n");
        if (text.length > READ_CHARS) text = text.slice(0, READ_CHARS) + "\n… (cut; read a smaller window)";
        const more = from - 1 + count < lines.length ? `\n… ${lines.length - (from - 1 + count)} more lines` : "";
        return { text: text + more, label: `Read ${rel}`, ok: true };
      },
    },
    {
      name: "ls", description: "List a folder. Default: projects/, your person's projects.",
      parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
      label: a => `Listing ${typeof a.path === "string" && a.path ? a.path : "projects"}`,
      async run(a) {
        const { abs, rel } = locate(ctx, typeof a.path === "string" && a.path ? a.path : "projects");
        const names = readdirSync(abs, { withFileTypes: true }).filter(e => e.name !== ".git")
          .map(e => e.isDirectory() || e.isSymbolicLink() ? `${e.name}/` : e.name).sort();
        return { text: names.join("\n") || "(empty)", label: `Listed ${rel}`, ok: true };
      },
    },
    {
      name: "write", description: "Create or replace a file. Writing in projects/<name> edits your person's copy in place; in desktops/<id>/<name>, your own worktree.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
      label: a => `Writing ${labelPath(a)}`,
      async run(a) {
        const where = locate(ctx, str(a.path, "a path"));
        if (typeof a.content !== "string") throw new AgentsError("Give the file's content.");
        const real = landing(where.abs, where.rel);
        mayWrite(ctx, real);
        lease(ctx, where.inPlace);
        mkdirSync(dirname(where.abs), { recursive: true });
        writeFileSync(where.abs, a.content);
        await ctx.file?.("wrote", real, a.content);
        return { text: `Wrote ${where.rel} (${a.content.length} characters).`, label: `Wrote ${where.rel}`, ok: true };
      },
    },
    {
      name: "edit", description: "Replace exact text in a file. old must match exactly once unless all is true.",
      parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" }, all: { type: "boolean" } }, required: ["path", "old", "new"], additionalProperties: false },
      label: a => `Editing ${labelPath(a)}`,
      async run(a) {
        const where = locate(ctx, str(a.path, "a path"));
        const oldText = str(a.old, "the exact text to replace");
        if (typeof a.new !== "string") throw new AgentsError("Give the replacement text.");
        if (!existsSync(where.abs)) throw new AgentsError(`${where.rel} doesn't exist.`);
        const real = landing(where.abs, where.rel);
        const body = readFileSync(where.abs, "utf8");
        await ctx.file?.("read", real, body);
        mayWrite(ctx, real);
        lease(ctx, where.inPlace);
        const count = body.split(oldText).length - 1;
        if (!count) throw new AgentsError(`That text isn't in ${where.rel}. Read the file again; it may have changed.`);
        if (count > 1 && a.all !== true) throw new AgentsError(`That text appears ${count} times in ${where.rel}; include more context, or set all.`);
        const next = a.all === true ? body.split(oldText).join(a.new) : body.replace(oldText, () => a.new as string);
        writeFileSync(where.abs, next);
        await ctx.file?.("wrote", real, next);
        const n = a.all === true ? count : 1;
        return { text: `Edited ${where.rel} (${n} replacement${n === 1 ? "" : "s"}).`, label: `Edited ${where.rel}`, ok: true };
      },
    },
    {
      name: "bash", description: "Run a shell command, in cwd (relative to your workspace; default projects/). It runs as your person, with their environment. Long-running commands such as dev servers return on their own once they're listening, and keep running.",
      parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"], additionalProperties: false },
      label: a => `Running ${short(String(a.command ?? ""))}`,
      async run(a, signal) {
        const command = str(a.command, "a command");
        const refused = ctx.shell?.(command);
        if (refused) return { text: refused, label: `Didn't run ${short(command)}: the shell is off`, ok: false };
        const where = locate(ctx, typeof a.cwd === "string" && a.cwd ? a.cwd : "projects");
        const result = await ctx.harbor.run(ctx.desktop, command, where.abs, signal);
        const tail = (s: string) => s.length > OUTPUT_CHARS ? "… (earlier output cut)\n" + s.slice(-OUTPUT_CHARS) : s;
        if (result.status === "exited") {
          const ok = result.code === 0;
          // A fixed-port server that collides names who holds the port.
          const busy = /EADDRINUSE[^\n]*?:(\d+)/.exec(result.output);
          const holder = busy ? await ctx.harbor.holder(Number(busy[1])) : undefined;
          const note = busy ? `\n[Port ${busy[1]} is in use${holder ? holder === ctx.desktop ? " by another of your own commands" : ` by desktop ${holder}` : " by a process outside any desktop"}.]` : "";
          return { text: `${tail(result.output) || "(no output)"}\n[exit ${result.code ?? result.signal}]${note}`, label: `Ran ${short(command)}${ok ? "" : ` (exit ${result.code ?? result.signal})`}`, ok };
        }
        for (const port of result.ports) ctx.server(port, result.job, command);
        const label = result.ports.length ? `Started ${short(command)} on :${result.ports.join(", :")}` : `Still running ${short(command)}`;
        return { text: `${tail(result.output)}\n[${result.note}]`, label, ok: true };
      },
    },
    {
      name: "start_work", description: "Give yourself your own git worktree of a project, on branch desktop/<id>, for changes that should be kept apart from your person's copy: anything more than a small fix, or when the project is busy. It shares the project's repo (branches, stashes and worktrees are the same), and its dependencies are already in place. Work there from then on.",
      parameters: { type: "object", properties: { project: { type: "string", description: "The project's name, as it appears in projects/." } }, required: ["project"], additionalProperties: false },
      label: a => `Starting work on ${String(a.project ?? "a project")}`,
      async run(a) {
        const record = await startWork(ctx.ws, ctx.desktop, str(a.project, "a project name"));
        ctx.started(record);
        const where = relative(ctx.ws.root, record.path);
        return { text: `Your worktree of ${record.project} is ${where}, on branch ${record.branch}${record.cloned.length ? ` (brought ${record.cloned.join(", ")})` : ""}. It shares ${record.project}'s repo. Make your changes there.`,
          label: `Started work on ${record.project} in ${where}`, ok: true };
      },
    },
  ];
}

const short = (t: string) => t.length > 60 ? t.slice(0, 57) + "…" : t;
