/**
 * agent.ts — each desktop's agent: a pi session in the desktop's folder.
 *
 * The host (BigBrain) supplies who the agent is and what it may reach beyond
 * its folder: the model runtime and model (credentials stay with the host;
 * `wrapStream` lets it attach them per request), the instructions, and host
 * tools. This module supplies the coding tools (tools.ts), the shell
 * (harbor.ts), worktrees on request (worktree.ts), and one durable event stream (events.ts).
 *
 * pi's own built-in tools never run: every tool the agent has is listed
 * here, as BigBrain's Pilot already does (lib/run/piSession.ts).
 */
import type { AgentSession, CreateAgentSessionOptions, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EventLog, type AgentEvent, type Stamped } from "./events";
import { discardWork, landWork, listWork, type LandHow, type Landed, type WorkRecord } from "./worktree";
import { run } from "./run";
import { Harbor, scopeOf } from "./harbor";
import { codingTools, type AgentTool } from "./tools";
import { AgentsError, checkDesktopId, releaseLeases, stateFolder, workspace, type Workspace } from "./workspace";

type Model = NonNullable<CreateAgentSessionOptions["model"]>;
type StreamFn = AgentSession["agent"]["streamFunction"];

export interface HostTool {
  name: string; description: string; parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  /** The activity line for a call, in plain words ("Searched the vault for orrery"); defaults to the tool's name. */
  label?(args: Record<string, unknown>): string;
}
export interface OpenOptions {
  modelRuntime: ModelRuntime;
  model: Model;
  instructions: string;
  tools?: HostTool[];
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  /** Wraps each model request, so the host can attach credentials without the package holding them. */
  wrapStream?: (stream: StreamFn) => StreamFn;
  /** What to tell the agent about a path outside its workspace that the host
   * knows, such as one a host tool reads; undefined leaves the plain refusal. */
  elsewhere?: (path: string) => string | undefined;
}

/** What the agent is told about where it works; the host's instructions come first. */
export const WORKING_INSTRUCTIONS = (id: string) => `
## Where you work
Paths are relative to your workspace.
- projects/<name> are your person's projects: their real checkouts, exactly as they see them. Reading, searching and running commands there is how you answer questions about them.
- Small, clear fixes can be made in place. For anything larger, or a project another desktop is editing, call start_work: it gives you your own git worktree at desktops/${id}/<name> on branch desktop/${id}, sharing the project's repo, with its dependencies in place. Then make your changes there.
- Commands run as your person, with their environment. Long-running commands such as dev servers return once they're listening, and keep running; say the address you were given.
- Commit finished work on your branch. Don't push, merge, rebase or switch branches in your person's checkouts unless they ask.`;

export class Agents {
  private desktops = new Map<string, Desktop>();
  constructor(readonly ws: Workspace = workspace(), readonly harbor = new Harbor({ scope: scopeOf(ws.root) })) {}

  async open(id: string, options: OpenOptions): Promise<Desktop> {
    checkDesktopId(id);
    const existing = this.desktops.get(id);
    if (existing) return existing;
    const desktop = new Desktop(this.ws, id, this.harbor);
    await desktop.start(options);
    this.desktops.set(id, desktop);
    return desktop;
  }

  /** Every desktop with a folder or state, open or not. */
  list(): string[] {
    const ids = new Set<string>();
    for (const dir of [this.ws.desktops, this.ws.state]) {
      try { for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".")) ids.add(e.name); } catch { /* none yet */ }
    }
    return [...ids].sort();
  }

  /** A desktop's event log, whether or not it's open. */
  private log(id: string): EventLog {
    return this.desktops.get(id)?.events ?? new EventLog(stateFolder(this.ws, checkDesktopId(id)));
  }

  /** Events for a desktop, whether or not it's open. */
  events(id: string, since = 0): Stamped[] { return this.log(id).since(since); }

  /** Delete a desktop's worktree of a project and its branch; its processes are stopped first. */
  async discard(id: string, project: string): Promise<void> {
    await this.harbor.stopDesktop(checkDesktopId(id));
    await discardWork(this.ws, id, project);
    this.log(id).append({ type: "work.discarded", project });
  }

  /** Bring a worktree's committed work home (worktree.ts, landWork). A person's verb: no tool exposes it to the agent. */
  async land(id: string, project: string, how: LandHow = "auto"): Promise<Landed> {
    const landed = await landWork(this.ws, checkDesktopId(id), project, how);
    this.log(id).append({ type: "project.landed", project,
      how: landed.how, branch: landed.branch, ...(landed.how === "pr" ? { url: landed.url } : {}) });
    return landed;
  }

  close(id: string): void { this.desktops.get(id)?.close(); this.desktops.delete(id); }
}

export class Desktop {
  readonly events: EventLog;
  readonly folder: string;
  private session?: AgentSession;
  private running?: Promise<void>;
  private inputs = new Set<string>();
  private status: Extract<AgentEvent, { type: "status" }>["status"] = "idle";

  constructor(private ws: Workspace, readonly id: string, private harbor: Harbor) {
    this.folder = ws.root;
    mkdirSync(ws.projects, { recursive: true });
    this.events = new EventLog(stateFolder(ws, id));
    for (const e of this.events.since()) {
      if (e.type === "input") this.inputs.add(e.inputId);
      if (e.type === "status") this.status = e.status === "working" ? "stopped" : e.status;
    }
  }

  private emit(event: AgentEvent): void {
    if (event.type === "status") this.status = event.status;
    this.events.append(event);
  }

  async start(options: OpenOptions): Promise<void> {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const state = stateFolder(this.ws, this.id);
    const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, enableAnalytics: false, enableInstallTelemetry: false, cacheWarming: "off" } as never);
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: this.folder, agentDir: state, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: `${options.instructions.trim()}\n${WORKING_INSTRUCTIONS(this.id)}` });
    await resourceLoader.reload();
    const sessionManager = sdk.SessionManager.continueRecent(this.folder, join(state, "sessions"));

    const tools: AgentTool[] = [
      ...codingTools({
        ws: this.ws, desktop: this.id, harbor: this.harbor, elsewhere: options.elsewhere,
        started: (r: WorkRecord) => this.emit({ type: "work.started", project: r.project, branch: r.branch, path: r.path, ms: r.ms, cloned: r.cloned }),
        server: (port, job, command) => {
          this.emit({ type: "server.started", port, job, command });
          void this.harbor.whenExited(job).then(x => this.emit({ type: "server.exited", job, code: x?.code ?? null }));
        },
      }),
      ...(options.tools ?? []).map((t): AgentTool => ({
        name: t.name, description: t.description, parameters: t.parameters, label: t.label,
        run: async (args, signal) => ({ text: JSON.stringify(await t.execute(args, signal)) ?? "null", label: t.label?.(args) ?? t.name, ok: true }),
      })),
    ];
    const names = new Set<string>();
    for (const t of tools) { if (names.has(t.name)) throw new AgentsError(`Two tools are called ${t.name}.`); names.add(t.name); }

    const customTools = tools.map(t => ({
      name: t.name, label: t.name, description: t.description,
      parameters: t.parameters as never,
      executionMode: "sequential" as const,
      execute: async (call: string, input: unknown, signal?: AbortSignal) => {
        const args = (input ?? {}) as Record<string, unknown>;
        this.emit({ type: "tool.start", call, tool: t.name, label: startLabel(t.name, args, t.label) });
        try {
          const r = await t.run(args, signal ?? new AbortController().signal);
          this.emit({ type: "tool.end", call, tool: t.name, label: r.label, ok: r.ok });
          return { content: [{ type: "text" as const, text: r.text }], details: {} };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.emit({ type: "tool.end", call, tool: t.name, label: `${startLabel(t.name, args, t.label)} failed`, ok: false });
          return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: {} };
        }
      },
    }));

    const { session } = await sdk.createAgentSession({ cwd: this.folder, agentDir: state, modelRuntime: options.modelRuntime, model: options.model,
      thinkingLevel: options.thinkingLevel, resourceLoader, settingsManager, sessionManager, tools: customTools.map(t => t.name), customTools });
    if (options.wrapStream) session.agent.streamFunction = options.wrapStream(session.agent.streamFunction);
    session.subscribe(event => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") this.emit({ type: "message.delta", text: event.assistantMessageEvent.delta });
      if (event.type === "message_end" && event.message.role === "assistant") {
        const m = event.message;
        const text = m.content.filter(b => b.type === "text").map(b => (b as { text: string }).text).join("");
        if (text) this.emit({ type: "message.done", text });
        if (m.stopReason === "error") this.emit({ type: "error", message: m.errorMessage ?? "The model returned an error.", recoverable: true });
      }
    });
    this.session = session;
  }

  /** Send a message. Busy: it queues as a follow-up. A repeated inputId does nothing. Resolves when the turn ends. */
  async send(text: string, inputId: string = crypto.randomUUID()): Promise<void> {
    if (this.inputs.has(inputId)) return this.running;
    const session = this.need();
    this.inputs.add(inputId);
    if (this.running) {
      this.emit({ type: "input", inputId, text, mode: "queued" });
      await session.followUp(text);
      return this.running;
    }
    this.emit({ type: "input", inputId, text, mode: "prompt" });
    this.emit({ type: "status", status: "working" });
    this.running = session.prompt(text).then(
      () => { this.emit({ type: "status", status: "idle" }); },
      error => {
        this.emit({ type: "error", message: error instanceof Error ? error.message : String(error), recoverable: true });
        this.emit({ type: "status", status: "failed" });
      },
    ).finally(() => { this.running = undefined; });
    return this.running;
  }

  /** Redirect the running turn; with nothing running, it's an ordinary message. */
  async steer(text: string, inputId: string = crypto.randomUUID()): Promise<void> {
    if (!this.running) return this.send(text, inputId);
    if (this.inputs.has(inputId)) return;
    this.inputs.add(inputId);
    this.emit({ type: "input", inputId, text, mode: "steer" });
    await this.need().steer(text);
  }

  async stop(): Promise<void> {
    if (!this.session) return;
    await this.session.abort();
    if (this.status === "working") this.emit({ type: "status", status: "stopped" });
  }

  /** The worktrees this desktop has started. */
  work(): WorkRecord[] { return listWork(this.ws, this.id); }

  /** Per worktree: branch, commits since it started, uncommitted files, and a diffstat. */
  async changes(): Promise<Array<{ project: string; branch: string; commits: number; dirty: number; stat: string }>> {
    return Promise.all(this.work().map(async f => {
      const [commits, dirty, stat] = await Promise.all([
        run("git", ["rev-list", "--count", `${f.base}..HEAD`], f.path),
        run("git", ["status", "--porcelain"], f.path),
        run("git", ["diff", "--shortstat", f.base], f.path),
      ]);
      return { project: f.project, branch: f.branch, commits: Number(commits.out.trim()) || 0,
        dirty: dirty.out.split("\n").filter(Boolean).length, stat: stat.out.trim() };
    }));
  }

  servers() { return this.harbor.servers(this.id); }

  async snapshot() {
    return { id: this.id, folder: this.folder, status: this.status, seq: this.events.last,
      work: this.work(), servers: await this.servers() };
  }

  /** Stop the desktop's processes and its session. Files stay; reopening resumes. */
  async archive(): Promise<void> {
    await this.stop();
    await this.harbor.stopDesktop(this.id);
    releaseLeases(this.ws, this.id);
    this.close();
    this.emit({ type: "status", status: "archived" });
  }

  close(): void { this.session?.dispose(); this.session = undefined; }

  private need(): AgentSession {
    if (!this.session) throw new AgentsError(`Desktop ${this.id} isn't open.`);
    return this.session;
  }
}

/** A tool's in-progress label: its own, or its name. */
function startLabel(tool: string, args: Record<string, unknown>, label?: (args: Record<string, unknown>) => string): string {
  return label?.(args) || tool;
}
