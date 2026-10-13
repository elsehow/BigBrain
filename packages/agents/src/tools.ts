/**
 * tools.ts — the coding tools a desktop's agent works with.
 *
 * Paths are relative to the workspace root (workspace.ts): the person's
 * projects at projects/<name>, the desktop's own worktrees at
 * desktops/<id>/<name>. Nothing is redirected and no command is classified:
 * the agent works where it says it works. Editing a project in place takes
 * its lease; start_work gives the desktop its own worktree (worktree.ts).
 * Files and commands go through the desktop's guest (guests.ts, guest.ts):
 * this module opens no file and runs no program itself (the plan's I1,
 * held by .oxlintrc.json). The guest runs under what the desktop may change
 * (sandbox.ts). Every result carries a plain-language label for the
 * desktop's activity line.
 */
import { join, relative, resolve, sep } from "node:path";
import { GuestError, type Guest } from "./guest";
import type { Harbor } from "./harbor";
import { confinement } from "./sandbox";
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
  server(port: number, job: number, command: string, hostPort?: number): void;
  /** The host's word on a path outside the workspace (OpenOptions.elsewhere). */
  elsewhere?(path: string): string | undefined;
  /** The host's word on a shell command before it runs (OpenOptions.shell). */
  shell?(command: string): string | undefined;
  /** The host's word on a file write before it lands (OpenOptions.write). */
  write?(path: string): string | undefined;
  /** Told what a file held when the file tools read or wrote it (OpenOptions.file). */
  file?(how: "read" | "wrote", path: string, content: string): void | Promise<void>;
  /** Whether the desktop has read untrusted material: its commands then write only its own folder (OpenOptions.untrusted). */
  untrusted?(): boolean;
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

/** A path the file tools never write: inside a repository's .git (its hooks and config run code), however spelled. */
function notGit(rel: string): void {
  if (rel.split(/[\\/]/).some(seg => seg.toLowerCase() === ".git")) throw new AgentsError(`${rel} is inside a .git folder; the file tools don't write there.`);
}

/** The host's own path for a file, where the guest's files are the host's: what its hooks are told. */
function real(ctx: ToolContext, abs: string, rel: string): string {
  return ctx.harbor.guests.real?.(abs, rel) ?? abs;
}

/** The guest's word on a file, in the agent's terms. */
function said(e: unknown, rel: string): never {
  if (!(e instanceof GuestError)) throw e;
  if (e.code === "not-found") throw new AgentsError(`${rel} doesn't exist.`);
  if (e.code === "is-directory") throw new AgentsError(`${rel} is a folder; use ls.`);
  if (e.code === "not-directory") throw new AgentsError(`${rel} is not a folder.`);
  if (e.code === "conflict") throw new AgentsError(`${rel} changed since you read it. Read it again.`);
  if (e.code === "too-large") throw new AgentsError(`${rel} is too large for the file tools; use bash.`);
  throw new AgentsError(`${rel}: ${e.message}`);
}

const guestOf = (ctx: ToolContext): Promise<Guest> => ctx.harbor.files(ctx.desktop, confinement(ctx.ws, ctx.desktop, ctx.untrusted?.() ?? false));

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
        const g = await guestOf(ctx);
        const got = await g.read(abs).catch(e => said(e, rel));
        if (got.data.length < got.size) throw new AgentsError(`${rel} is too large for the file tools (${got.size} bytes); use bash.`);
        const body = got.data.toString("utf8");
        if (ctx.file) await ctx.file("read", real(ctx, abs, rel), body);
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
        const g = await guestOf(ctx);
        const listed = await g.list(abs).catch(e => said(e, rel));
        const names = listed.entries.filter(e => e.name !== ".git").map(e => e.kind === "dir" || e.kind === "link" ? `${e.name}/` : e.name).sort();
        const more = listed.truncated ? "\n… (more entries; use bash to list them)" : "";
        return { text: (names.join("\n") || "(empty)") + more, label: `Listed ${rel}`, ok: true };
      },
    },
    {
      name: "write", description: "Create or replace a file. Writing in projects/<name> edits your person's copy in place; in desktops/<id>/<name>, your own worktree.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
      label: a => `Writing ${labelPath(a)}`,
      async run(a) {
        const where = locate(ctx, str(a.path, "a path"));
        if (typeof a.content !== "string") throw new AgentsError("Give the file's content.");
        notGit(where.rel);
        const host = real(ctx, where.abs, where.rel);
        mayWrite(ctx, host);
        lease(ctx, where.inPlace);
        const g = await guestOf(ctx);
        await g.write(where.abs, a.content, { parents: true }).catch(e => said(e, where.rel));
        if (ctx.file) await ctx.file("wrote", host, a.content);
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
        notGit(where.rel);
        const g = await guestOf(ctx);
        const was = await g.read(where.abs).catch(e => said(e, where.rel));
        if (was.data.length < was.size) throw new AgentsError(`${where.rel} is too large for the file tools (${was.size} bytes); use bash.`);
        const host = real(ctx, where.abs, where.rel);
        const body = was.data.toString("utf8");
        if (ctx.file) await ctx.file("read", host, body);
        mayWrite(ctx, host);
        lease(ctx, where.inPlace);
        const count = body.split(oldText).length - 1;
        if (!count) throw new AgentsError(`That text isn't in ${where.rel}. Read the file again; it may have changed.`);
        if (count > 1 && a.all !== true) throw new AgentsError(`That text appears ${count} times in ${where.rel}; include more context, or set all.`);
        const next = a.all === true ? body.split(oldText).join(a.new) : body.replace(oldText, () => a.new as string);
        // only over what was read: a change made since is the agent's to see first
        await g.write(where.abs, next, { ifMatch: was.sha256 ?? null }).catch(e => said(e, where.rel));
        if (ctx.file) await ctx.file("wrote", host, next);
        const n = a.all === true ? count : 1;
        return { text: `Edited ${where.rel} (${n} replacement${n === 1 ? "" : "s"}).`, label: `Edited ${where.rel}`, ok: true };
      },
    },
    {
      name: "bash", description: "Run a shell command, in cwd (relative to your workspace; default projects/). It runs in a sandbox, with your person's environment. Long-running commands such as dev servers return on their own once they're listening, and keep running as a job; stop_job stops one.",
      parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"], additionalProperties: false },
      label: a => `Running ${short(String(a.command ?? ""))}`,
      async run(a, signal) {
        const command = str(a.command, "a command");
        const refused = ctx.shell?.(command);
        if (refused) return { text: refused, label: `Didn't run ${short(command)}: the shell is off`, ok: false };
        const where = locate(ctx, typeof a.cwd === "string" && a.cwd ? a.cwd : "projects");
        const untrusted = ctx.untrusted?.() ?? false;
        const result = await ctx.harbor.run(ctx.desktop, command, where.abs, signal, confinement(ctx.ws, ctx.desktop, untrusted));
        const tail = (s: string) => s.length > OUTPUT_CHARS ? "… (earlier output cut)\n" + s.slice(-OUTPUT_CHARS) : s;
        if (result.status === "exited") {
          const ok = result.code === 0;
          // A fixed-port server that collides names who holds the port.
          // node's words, and bun's
          const busy = /EADDRINUSE[^\n]*?:(\d+)|Is port (\d+) in use/.exec(result.output);
          const busyPort = busy ? busy[1] ?? busy[2] : undefined;
          const holder = busyPort ? await ctx.harbor.holder(Number(busyPort)) : undefined;
          const note = busyPort ? `\n[Port ${busyPort} is in use${holder ? holder === ctx.desktop ? " by another of your own commands" : ` by desktop ${holder}` : " by a process outside any desktop"}.]`
            : !ok && /Operation not permitted|403 Forbidden/.test(result.output) ? `\n[The sandbox may have refused that. Commands write only ${untrusted ? `your own folder (desktops/${ctx.desktop}/…)` : "your own folder and projects no other desktop is editing"} and your temp folder, reach the internet only through a proxy to allowlisted hosts, and can't reach your person's credentials or other programs.]` : "";
          return { text: `${tail(result.output) || "(no output)"}\n[exit ${result.code ?? result.signal}]${note}`, label: `Ran ${short(command)}${ok ? "" : ` (exit ${result.code ?? result.signal})`}`, ok };
        }
        for (const port of result.ports) ctx.server(port, result.job, command, result.hostPorts[port]);
        const label = result.ports.length ? `Started ${short(command)} on :${result.ports.join(", :")}` : `Still running ${short(command)}`;
        return { text: `${tail(result.output)}\n[${result.note}]`, label, ok: true };
      },
    },
    {
      name: "stop_job", description: "Stop a command still running as a job (a dev server, a watcher), by the job number its bash result gave.",
      parameters: { type: "object", properties: { job: { type: "integer", minimum: 1 } }, required: ["job"], additionalProperties: false },
      label: a => `Stopping job ${String(a.job ?? "")}`,
      async run(a) {
        const job = ctx.harbor.job(Number(a.job));
        if (!job || job.desktop !== ctx.desktop) throw new AgentsError(`You have no job ${String(a.job)}.`);
        if (!job.exited) await ctx.harbor.stopJob(job.id);
        return { text: `Stopped job ${job.id} (${short(job.command)}).`, label: `Stopped ${short(job.command)}`, ok: true };
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
