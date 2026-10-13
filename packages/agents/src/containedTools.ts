/**
 * containedTools.ts — a contained desktop's tools (the plan's "Today's tools
 * over it" and Projects): the agent works in its machine, on copies of the
 * person's projects at /work/<name>.
 *
 * Paths are the machine's: relative ones are under /work. The machine is
 * the boundary, so no path is refused for where it is; only a write into a
 * .git folder is, by the agent's own spelling (the guest follows links on
 * its own disk, and host git never runs in a copy). There are no leases and
 * no start_work: every desktop has its own copy, on desktop/<id>, and two
 * desktops meet at Land. This module opens no file and runs no program
 * itself (I1): the guest does both, and host git runs in projects.ts.
 */
import { posix } from "node:path";
import { GuestError } from "./guest";
import type { Harbor } from "./harbor";
import type { AgentTool, ToolResult } from "./tools";
import { openProject, projectState, syncProject, WORK, type CopyRecord } from "./projects";
import { AgentsError, listProjects, type Workspace } from "./workspace";

export interface ContainedContext {
  ws: Workspace; desktop: string; harbor: Harbor;
  opened(record: CopyRecord): void;
  synced(project: string, from: string, to: string): void;
  server(port: number, job: number, command: string): void;
  /** The host's word on a path the machine doesn't have (OpenOptions.elsewhere): a vault note, say. */
  elsewhere?(path: string): string | undefined;
}

const READ_LINES = 2000, READ_CHARS = 60_000, OUTPUT_CHARS = 30_000;
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new AgentsError(`Give ${what}.`);
  return v;
};
const short = (t: string) => t.length > 60 ? t.slice(0, 57) + "…" : t;

/** A path in the machine: absolute as given, else under /work. */
export function inMachine(path: string): { abs: string; rel: string } {
  const abs = posix.resolve(WORK, path);
  const rel = abs === WORK ? "/work" : abs.startsWith(`${WORK}/`) ? abs.slice(WORK.length + 1) : abs;
  return { abs, rel };
}

function notGit(rel: string): void {
  if (rel.split("/").some(seg => seg.toLowerCase() === ".git")) throw new AgentsError(`${rel} is inside a .git folder; the file tools don't write there.`);
}

export function containedTools(ctx: ContainedContext): AgentTool[] {
  const guest = () => ctx.harbor.files(ctx.desktop);
  const said = (e: unknown, path: string, rel: string): never => {
    if (!(e instanceof GuestError)) throw e;
    if (e.code === "not-found") throw new AgentsError(ctx.elsewhere?.(path) ?? `${rel} doesn't exist in your machine.${rel.split("/")[0] && listProjects(ctx.ws).some(p => p.name === rel.split("/")[0]) ? ` Call open_project for ${rel.split("/")[0]} first.` : ""}`);
    if (e.code === "is-directory") throw new AgentsError(`${rel} is a folder; use ls.`);
    if (e.code === "not-directory") throw new AgentsError(`${rel} is not a folder.`);
    if (e.code === "conflict") throw new AgentsError(`${rel} changed since you read it. Read it again.`);
    if (e.code === "too-large") throw new AgentsError(`${rel} is too large for the file tools; use bash.`);
    throw new AgentsError(`${rel}: ${e.message}`);
  };
  const labelPath = (a: Record<string, unknown>) => typeof a.path === "string" && a.path ? a.path : "your machine";
  const projectArg = (a: Record<string, unknown>) => {
    const name = str(a.project, "a project name");
    if (!listProjects(ctx.ws).some(p => p.name === name)) throw new AgentsError(`There is no project ${JSON.stringify(name)}. Your person's projects: ${listProjects(ctx.ws).map(p => p.name).join(", ") || "none yet"}.`);
    return name;
  };

  return [
    {
      name: "read", description: "Read a file in your machine. Relative paths are under /work, where your copies of your person's projects are (/work/<name>). Returns numbered lines; use offset and limit for long files.",
      parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false },
      label: a => `Reading ${labelPath(a)}`,
      async run(a): Promise<ToolResult> {
        const path = str(a.path, "a path");
        const { abs, rel } = inMachine(path);
        const got = await (await guest()).read(abs).catch(e => said(e, path, rel));
        if (got.data.length < got.size) throw new AgentsError(`${rel} is too large for the file tools (${got.size} bytes); use bash.`);
        const lines = got.data.toString("utf8").split("\n");
        const from = Math.max(1, Number(a.offset) || 1), count = Math.min(READ_LINES, Number(a.limit) || READ_LINES);
        let text = lines.slice(from - 1, from - 1 + count).map((l, i) => `${from + i}\t${l}`).join("\n");
        if (text.length > READ_CHARS) text = text.slice(0, READ_CHARS) + "\n… (cut; read a smaller window)";
        const more = from - 1 + count < lines.length ? `\n… ${lines.length - (from - 1 + count)} more lines` : "";
        return { text: text + more, label: `Read ${rel}`, ok: true };
      },
    },
    {
      name: "ls", description: "List a folder in your machine. Default: /work, your copies of your person's projects.",
      parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
      label: a => `Listing ${typeof a.path === "string" && a.path ? a.path : "/work"}`,
      async run(a): Promise<ToolResult> {
        const path = typeof a.path === "string" && a.path ? a.path : WORK;
        const { abs, rel } = inMachine(path);
        const listed = await (await guest()).list(abs).catch(e => said(e, path, rel));
        const names = listed.entries.filter(e => e.name !== ".git" && !(abs === WORK && e.name.startsWith(".")))
          .map(e => e.kind === "dir" || e.kind === "link" ? `${e.name}/` : e.name).sort();
        const hint = abs === WORK ? `\n(Your person's projects: ${listProjects(ctx.ws).map(p => p.name).join(", ") || "none"}. open_project copies one here.)` : "";
        return { text: (names.join("\n") || "(empty)") + (listed.truncated ? "\n… (more entries; use bash)" : "") + hint, label: `Listed ${rel}`, ok: true };
      },
    },
    {
      name: "write", description: "Create or replace a file in your machine.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
      label: a => `Writing ${labelPath(a)}`,
      async run(a): Promise<ToolResult> {
        const path = str(a.path, "a path");
        const { abs, rel } = inMachine(path);
        if (typeof a.content !== "string") throw new AgentsError("Give the file's content.");
        notGit(rel);
        await (await guest()).write(abs, a.content, { parents: true }).catch(e => said(e, path, rel));
        return { text: `Wrote ${rel} (${a.content.length} characters).`, label: `Wrote ${rel}`, ok: true };
      },
    },
    {
      name: "edit", description: "Replace exact text in a file in your machine. old must match exactly once unless all is true.",
      parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" }, all: { type: "boolean" } }, required: ["path", "old", "new"], additionalProperties: false },
      label: a => `Editing ${labelPath(a)}`,
      async run(a): Promise<ToolResult> {
        const path = str(a.path, "a path");
        const { abs, rel } = inMachine(path);
        const oldText = str(a.old, "the exact text to replace");
        if (typeof a.new !== "string") throw new AgentsError("Give the replacement text.");
        notGit(rel);
        const g = await guest();
        const was = await g.read(abs).catch(e => said(e, path, rel));
        if (was.data.length < was.size) throw new AgentsError(`${rel} is too large for the file tools (${was.size} bytes); use bash.`);
        const body = was.data.toString("utf8");
        const count = body.split(oldText).length - 1;
        if (!count) throw new AgentsError(`That text isn't in ${rel}. Read the file again; it may have changed.`);
        if (count > 1 && a.all !== true) throw new AgentsError(`That text appears ${count} times in ${rel}; include more context, or set all.`);
        const next = a.all === true ? body.split(oldText).join(a.new) : body.replace(oldText, () => a.new as string);
        await g.write(abs, next, { ifMatch: was.sha256 ?? null }).catch(e => said(e, path, rel));
        const n = a.all === true ? count : 1;
        return { text: `Edited ${rel} (${n} replacement${n === 1 ? "" : "s"}).`, label: `Edited ${rel}`, ok: true };
      },
    },
    {
      name: "bash", description: "Run a shell command in your machine, in cwd (default /work). Long-running commands such as dev servers return on their own once they're listening, and keep running as a job; stop_job stops one. The machine reaches the internet only through a proxy to package registries, GitHub and hosts your person allows.",
      parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"], additionalProperties: false },
      label: a => `Running ${short(String(a.command ?? ""))}`,
      async run(a, signal): Promise<ToolResult> {
        const command = str(a.command, "a command");
        const { abs } = inMachine(typeof a.cwd === "string" && a.cwd ? a.cwd : WORK);
        const result = await ctx.harbor.run(ctx.desktop, command, abs, signal);
        const tail = (s: string) => s.length > OUTPUT_CHARS ? "… (earlier output cut)\n" + s.slice(-OUTPUT_CHARS) : s;
        if (result.status === "exited") {
          const ok = result.code === 0;
          const note = !ok && /403 Forbidden|refused .*:443|BigBrain's sandbox refused/.test(result.output)
            ? "\n[The proxy refused a host. Your machine reaches only package registries, GitHub and hosts your person allows; request_host asks for another.]" : "";
          return { text: `${tail(result.output) || "(no output)"}\n[exit ${result.code ?? result.signal}]${note}`, label: `Ran ${short(command)}${ok ? "" : ` (exit ${result.code ?? result.signal})`}`, ok };
        }
        for (const port of result.ports) ctx.server(port, result.job, command);
        const label = result.ports.length ? `Started ${short(command)} on :${result.ports.join(", :")}` : `Still running ${short(command)}`;
        return { text: `${tail(result.output)}\n[${result.note}]`, label, ok: true };
      },
    },
    {
      name: "stop_job", description: "Stop a command still running as a job (a dev server, a watcher), by the job number its bash result gave.",
      parameters: { type: "object", properties: { job: { type: "integer", minimum: 1 } }, required: ["job"], additionalProperties: false },
      label: a => `Stopping job ${String(a.job ?? "")}`,
      async run(a): Promise<ToolResult> {
        const job = ctx.harbor.job(Number(a.job));
        if (!job || job.desktop !== ctx.desktop) throw new AgentsError(`You have no job ${String(a.job)}.`);
        if (!job.exited) await ctx.harbor.stopJob(job.id);
        return { text: `Stopped job ${job.id} (${short(job.command)}).`, label: `Stopped ${short(job.command)}`, ok: true };
      },
    },
    {
      name: "open_project", description: "Copy one of your person's projects into your machine, at /work/<name>, on your own branch desktop/<id> from their current branch. Their checkout is never changed: your work reaches them when they land it. Uncommitted changes in their checkout aren't copied. Opening a project you have open does nothing.",
      parameters: { type: "object", properties: { project: { type: "string", description: "The project's name, as your person's projects are listed." } }, required: ["project"], additionalProperties: false },
      label: a => `Copying ${String(a.project ?? "a project")}`,
      async run(a): Promise<ToolResult> {
        const name = projectArg(a);
        const r = await openProject(ctx.ws, ctx.desktop, await guest(), name);
        if (r.bytes) ctx.opened(r);
        const at = r.base.slice(0, 7);
        return r.bytes
          ? { text: `Copied ${name} to /work/${name} at ${at}${r.branch ? ` (${r.branch})` : ""}, on your branch ${r.desktopBranch}, in ${(r.ms / 1000).toFixed(1)} s.${r.partial ? " Its history is large, so only that branch and the tags came." : ""} Your person's uncommitted changes, if any, are not in it; project_state shows them.`,
            label: `Copied ${name} at ${at}${r.branch ? ` (${r.branch})` : ""}`, ok: true }
          : { text: `${name} is already open at /work/${name}. sync_project brings in your person's newer commits.`, label: `${name} was already open`, ok: true };
      },
    },
    {
      name: "sync_project", description: "Bring your copy's view of your person's branches up to date with their checkout. Your own branch doesn't move: rebase or merge yourself if you need their newer work.",
      parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false },
      label: a => `Syncing ${String(a.project ?? "a project")}`,
      async run(a): Promise<ToolResult> {
        const name = projectArg(a);
        const r = await syncProject(ctx.ws, ctx.desktop, await guest(), name);
        ctx.synced(name, r.from, r.to);
        const moved = r.from && r.from !== r.to ? `from ${r.from.slice(0, 7)} to ${r.to.slice(0, 7)}` : `at ${r.to.slice(0, 7)}, unchanged`;
        return { text: `Synced ${name}: your person's branch is ${moved}. Your branch desktop/${ctx.desktop} is where you left it.`, label: `Synced ${name} (${moved})`, ok: true };
      },
    },
    {
      name: "project_state", description: "The state of your person's real checkout of a project, read on their computer: branch, HEAD, uncommitted files, stashes, worktrees, remotes, tags and recent commits. Use it for questions about their checkout, which your copy can't answer.",
      parameters: { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false },
      label: a => `Looking at ${String(a.project ?? "a project")}`,
      async run(a): Promise<ToolResult> {
        const name = projectArg(a);
        const s = await projectState(ctx.ws, name);
        const section = (title: string, xs: string[]) => `${title}:\n${xs.length ? xs.map(x => `  ${x}`).join("\n") : "  (none)"}`;
        const text = [
          `${name}: on ${s.branch} at ${s.head.slice(0, 12)}`,
          section(`uncommitted (${s.status.count})`, s.status.files),
          section("stashes", s.stashes), section("worktrees", s.worktrees), section("remotes", s.remotes),
          section("tags", s.tags), section("recent commits", s.log),
        ].join("\n");
        return { text, label: `Looked at ${name} (${s.branch}, ${s.status.count} uncommitted)`, ok: true };
      },
    },
  ];
}
