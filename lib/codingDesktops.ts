/**
 * codingDesktops.ts — v2's desktops whose agent can work on code.
 *
 * Each one is an agent run by packages/agents (a pi session working on forks
 * of the person's projects; docs/design/coding-desktops.md) with BigBrain as
 * its host (lib/agentHost.ts). BigBrain keeps what is BigBrain's: the
 * desktop's record (title, model, starting context, the views beside its
 * chat) under `.spool/coding-desktops/`, Quick naming, and the tools that put
 * vault notes and local pages on the desktop. The conversation itself is the
 * package's event stream, read back into a transcript here.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { Agents, type Desktop, type HostTool, type LandHow, type OpenOptions, type Stamped } from "../packages/agents/src";
import { agentHost } from "./agentHost";
import { writeAtomic } from "./fsx";
import { pilotToolCall } from "./pilot";
import { arrangeDesktop, closeView, desktopDetail, desktopReference, DESKTOP_TOOLS, DesktopError, emptyDesktop, loopbackUrl, openView, SHOW_PAGE_TOOL, type PilotDesktop } from "./pilotDesktop";
import { namingMoment, type TaskNamer } from "./pilotTaskName";
import { spoolDir } from "./spool";

export interface CodingDesktopRecord {
  id: string;
  title: string;
  titleSource?: "auto" | "human";
  created: string;
  updated: string;
  /** `provider/model`; absent means the default agent model. */
  model?: string;
  /** What the desktop was started about (Shift+Enter on an item). */
  context?: Array<{ path: string; title: string }>;
  desktop?: PilotDesktop;
  archivedAt?: string;
}

export interface TranscriptItem { id: string; role: "user" | "assistant" | "activity"; text: string; at: string; ok?: boolean }

const ID = /^d-[a-f0-9]{8}$/;
/** The package's last status, as the bar's phase. */
const PHASE: Record<string, "working" | "failed" | "interrupted" | "answered"> = { working: "working", waiting: "working", failed: "failed", stopped: "interrupted", idle: "answered" };
const UNTITLED = "New desktop";

export class CodingDesktopError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type HostFn = (root: string, model?: string) => Promise<OpenOptions>;

export class CodingDesktops {
  readonly agents: Agents;
  private dir: string;
  private opening = new Map<string, Promise<Desktop>>();
  private turns = new Map<string, Promise<void>>();
  private streams = new Map<string, Set<ServerResponse>>();
  private naming = new Map<string, number>();

  constructor(private root: string, private options: { agents?: Agents; host?: HostFn; nameTask?: TaskNamer } = {}) {
    this.agents = options.agents ?? new Agents();
    this.dir = join(spoolDir(root), "coding-desktops");
    mkdirSync(this.dir, { recursive: true });
    // After a restart no agent is running, so any tagged process is left over.
    void this.agents.harbor.stopAll().catch(() => {});
  }

  // ── records ───────────────────────────────────────────────────────────────
  private file(id: string): string {
    if (!ID.test(id)) throw new CodingDesktopError("Unknown desktop.", 404);
    return join(this.dir, `${id}.json`);
  }
  get(id: unknown): CodingDesktopRecord {
    const file = this.file(String(id));
    if (!existsSync(file)) throw new CodingDesktopError("Unknown desktop.", 404);
    return JSON.parse(readFileSync(file, "utf8")) as CodingDesktopRecord;
  }
  private save(r: CodingDesktopRecord): CodingDesktopRecord {
    r.updated = new Date().toISOString();
    writeAtomic(this.file(r.id), JSON.stringify(r, null, 2), 0o600);
    this.notify(r.id);
    return r;
  }

  create(input: { title?: unknown; context?: unknown; model?: unknown } = {}): CodingDesktopRecord {
    const id = `d-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const now = new Date().toISOString();
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 100) : UNTITLED;
    const context = Array.isArray(input.context)
      ? input.context.filter((c): c is { path: string; title?: string } => !!c && typeof (c as { path?: unknown }).path === "string")
        .slice(0, 20).map(c => ({ path: c.path, title: typeof c.title === "string" ? c.title : c.path }))
      : undefined;
    return this.save({ id, title, created: now, updated: now,
      ...(typeof input.model === "string" && input.model.includes("/") ? { model: input.model } : {}),
      ...(context?.length ? { context } : {}) });
  }

  list(): ReturnType<CodingDesktops["summary"]>[] {
    return readdirSync(this.dir).filter(f => f.endsWith(".json"))
      .map(f => this.summary(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as CodingDesktopRecord))
      .sort((a, b) => a.created.localeCompare(b.created));
  }

  summary(r: CodingDesktopRecord) {
    const events = this.agents.events(r.id);
    const status = [...events].reverse().find(e => e.type === "status" && e.status !== "archived");
    const phase = !events.some(e => e.type === "input") ? "draft" : (status?.type === "status" && PHASE[status.status]) || "answered";
    return {
      id: r.id, kind: "coding" as const, title: r.title, titleSource: r.titleSource ?? "auto", model: r.model ?? "default",
      phase, lifecycle: "active" as const, created: r.created, updated: r.updated,
      lastActivityAt: events.at(-1)?.at ?? r.updated,
      ...(r.archivedAt ? { deactivatedAt: r.archivedAt } : {}),
      contextNodes: (r.context ?? []).map(c => ({ id: c.path, path: c.path, title: c.title })),
    };
  }

  /** Everything a desktop shows: the transcript, its views, its forks' changes and its servers. */
  async detail(id: unknown) {
    const r = this.get(id);
    const events = this.agents.events(r.id);
    const open = await this.peek(r.id);
    const last = [...events].reverse().find(e => e.type === "error" || e.type === "status");
    return { ...this.summary(r), messages: transcript(events), seq: events.at(-1)?.seq ?? 0,
      ...(r.desktop ? { desktop: desktopDetail(r.desktop) } : {}),
      changes: open ? await open.changes() : [], servers: open ? await open.servers() : [],
      ...(last?.type === "error" ? { error: last.message } : {}) };
  }

  // ── the agent ─────────────────────────────────────────────────────────────
  private async peek(id: string): Promise<Desktop | undefined> {
    return this.opening.get(id)?.catch(() => undefined);
  }

  private open(id: string): Promise<Desktop> {
    const known = this.opening.get(id);
    if (known) return known;
    const r = this.get(id);
    const work = (async () => {
      const host = await (this.options.host ?? agentHost)(this.root, r.model);
      const about = r.context?.length ? `\nThis desktop was started about: ${r.context.map(c => `${c.title} (${c.path})`).join("; ")}.` : "";
      const desktop = await this.agents.open(id, { ...host, instructions: host.instructions + about,
        tools: [...(host.tools ?? []), ...this.viewTools(id)] });
      desktop.events.subscribe(e => this.broadcast(id, e));
      return desktop;
    })();
    this.opening.set(id, work);
    work.catch(() => this.opening.delete(id));
    return work;
  }

  async send(id: unknown, text: unknown, inputId: unknown): Promise<ReturnType<CodingDesktops["summary"]>> {
    const r = this.get(id);
    if (typeof text !== "string" || !text.trim()) throw new CodingDesktopError("Write a message first.");
    if (r.archivedAt) { delete r.archivedAt; this.save(r); }
    const desktop = await this.open(r.id);
    const turn = desktop.send(text.trim(), typeof inputId === "string" ? inputId : undefined);
    if (!this.turns.has(r.id)) {
      const tracked = turn.finally(() => { this.turns.delete(r.id); void this.retitle(r.id); });
      this.turns.set(r.id, tracked);
    }
    return this.summary(this.get(r.id));
  }

  async steer(id: unknown, text: unknown, inputId: unknown): Promise<void> {
    const r = this.get(id);
    if (typeof text !== "string" || !text.trim()) throw new CodingDesktopError("Write a message first.");
    await (await this.open(r.id)).steer(text.trim(), typeof inputId === "string" ? inputId : undefined);
  }

  async stop(id: unknown): Promise<void> {
    const open = await this.peek(this.get(id).id);
    await open?.stop();
  }

  /** Stop the agent and its processes; files and the transcript stay. Sending again reopens it. */
  async archive(id: unknown): Promise<CodingDesktopRecord> {
    const r = this.get(id);
    const open = await this.peek(r.id);
    if (open) await open.archive(); else await this.agents.harbor.stopDesktop(r.id);
    this.agents.close(r.id);
    this.opening.delete(r.id);
    r.archivedAt = new Date().toISOString();
    return this.save(r);
  }

  land(id: unknown, project: unknown, how: unknown) {
    const r = this.get(id);
    if (typeof project !== "string" || !project) throw new CodingDesktopError("Say which project to land.");
    return this.agents.land(r.id, project, how === "pr" || how === "branch" ? how : "auto" as LandHow);
  }

  async discard(id: unknown, project: unknown): Promise<void> {
    const r = this.get(id);
    if (typeof project !== "string" || !project) throw new CodingDesktopError("Say which project's copy to discard.");
    await this.agents.discard(r.id, project);
  }

  rename(id: unknown, title: unknown): CodingDesktopRecord {
    const r = this.get(id);
    if (typeof title !== "string" || !title.trim() || title.length > 100) throw new CodingDesktopError("Choose a title under 100 characters.");
    r.title = title.trim(); r.titleSource = "human";
    return this.save(r);
  }

  /** Change the agent's model. It takes effect at the next message, which reopens the session. */
  async setModel(id: unknown, model: unknown): Promise<CodingDesktopRecord> {
    const r = this.get(id);
    if (typeof model !== "string" || !/^[\w.-]+\/[\w.:-]+$/.test(model)) throw new CodingDesktopError("Name the model as provider/model.");
    if (this.turns.has(r.id)) throw new CodingDesktopError("Wait for the agent to finish before changing its model.", 409);
    this.agents.close(r.id);
    this.opening.delete(r.id);
    r.model = model;
    return this.save(r);
  }

  /** The person's hand on the views: close one, or arrange the tiles. */
  view(id: unknown, action: unknown, body: Record<string, unknown>): CodingDesktopRecord {
    const r = this.get(id);
    const d = r.desktop ?? emptyDesktop();
    r.desktop = rule(() => {
      if (action === "close" && typeof body.view === "string") return closeView(d, body.view, "human");
      if (action === "arrange") return arrangeDesktop(d, body.layout, "human");
      throw new CodingDesktopError('Choose "close" with a view, or "arrange" with a layout.');
    });
    return this.save(r);
  }

  /** Quick names the desktop as the conversation develops, never over a person's title. */
  private async retitle(id: string): Promise<void> {
    const namer = this.options.nameTask;
    const r = this.get(id);
    if (!namer || r.titleSource === "human") return;
    const items = transcript(this.agents.events(id));
    const asked = items.filter(m => m.role === "user").length;
    const due = r.title === UNTITLED || r.title.startsWith("Re: ") ? true : namingMoment(asked);
    if (!due || (this.naming.get(id) ?? 0) >= asked) return;
    this.naming.set(id, asked);
    const name = await namer(this.root, items.filter(m => m.role !== "activity").map(m => ({ role: m.role as "user" | "assistant", text: m.text })), r.title).catch(() => null);
    const live = this.get(id);
    if (name && live.titleSource !== "human" && live.title !== name) { live.title = name; live.titleSource = "auto"; this.save(live); }
  }

  // ── views the agent opens ─────────────────────────────────────────────────
  private viewTools(id: string): HostTool[] {
    const change = async (step: (d: PilotDesktop) => PilotDesktop) => {
      const r = this.get(id);
      r.desktop = rule(() => step(r.desktop ?? emptyDesktop()));
      this.save(r);
      return desktopReference(r.desktop);
    };
    const def = (name: string) => [...DESKTOP_TOOLS, SHOW_PAGE_TOOL].find(t => t.name === name)!;
    const tool = (name: string, run: (a: Record<string, unknown>) => Promise<unknown>, label: (a: Record<string, unknown>) => string): HostTool =>
      ({ name, description: def(name).description, parameters: def(name).parameters as Record<string, unknown>, execute: a => run(a), label });
    const viewId = () => `v-${crypto.randomUUID().slice(0, 6)}`;
    return [
      tool("open_view", async a => {
        if (typeof a.path !== "string" || !a.path.trim()) throw new Error("Give the note's exact vault path.");
        const path = a.path.trim();
        const note = await pilotToolCall(this.root, "read_note", { path, chars: 1 }).catch(() => null) as { title?: unknown } | null;
        if (!note) throw new Error("That note could not be read; open_view needs an exact vault path.");
        const title = typeof note.title === "string" && note.title.trim() ? note.title.trim() : path.split("/").pop()!.replace(/\.md$/, "");
        return change(d => openView(d, { kind: "note", path, title, at: new Date().toISOString() }, viewId(), { userAsked: a.user_asked === true }));
      }, a => `Showed ${String(a.path ?? "a note")}`),
      tool("show_page", async a => {
        const url = rule(() => loopbackUrl(a.url));
        const title = typeof a.title === "string" && a.title.trim() ? a.title.trim().slice(0, 60) : new URL(url).host;
        return change(d => openView(d, { kind: "url", path: url, title, at: new Date().toISOString() }, viewId(), { userAsked: a.user_asked === true }));
      }, a => `Showed ${String(a.url ?? "a page")}`),
      tool("close_view", async a => {
        if (typeof a.view !== "string") throw new Error("Give the view's id from your desktop reference.");
        const view = a.view;
        return change(d => closeView(d, view, "agent"));
      }, () => "Closed a view"),
      tool("arrange_desktop", async a => change(d => arrangeDesktop(d, a.layout, "agent")), () => "Arranged the desktop"),
    ];
  }

  // ── the live stream ───────────────────────────────────────────────────────
  /** Server-sent events: everything after `since`, then live events (text deltas
   * included) and a `record` ping whenever the desktop's record changes. */
  stream(id: unknown, since: number, res: ServerResponse, onClose: (fn: () => void) => void): void {
    const r = this.get(id);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    for (const e of this.agents.events(r.id, since)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    res.write(": live\n\n");
    let set = this.streams.get(r.id);
    if (!set) { set = new Set(); this.streams.set(r.id, set); }
    set.add(res);
    onClose(() => { set!.delete(res); });
  }
  private broadcast(id: string, e: Stamped): void {
    for (const res of this.streams.get(id) ?? []) res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  private notify(id: string): void {
    for (const res of this.streams.get(id) ?? []) res.write(`event: record\ndata: {}\n\n`);
  }

  close(): void {
    for (const id of this.opening.keys()) this.agents.close(id);
    for (const set of this.streams.values()) for (const res of set) res.end();
  }
}

/** The package's events, read back as a conversation with its activity lines. */
export function transcript(events: Stamped[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const e of events) {
    if (e.type === "input") out.push({ id: e.inputId, role: "user", text: e.text, at: e.at });
    else if (e.type === "message.done") out.push({ id: `m${e.seq}`, role: "assistant", text: e.text, at: e.at });
    else if (e.type === "tool.end") out.push({ id: `a${e.seq}`, role: "activity", text: e.label, at: e.at, ok: e.ok });
    else if (e.type === "project.forked") out.push({ id: `a${e.seq}`, role: "activity", text: `Made its own copy of ${e.project} (branch ${e.branch})`, at: e.at, ok: true });
    else if (e.type === "project.landed") out.push({ id: `a${e.seq}`, role: "activity", text: e.how === "pr" ? `Opened a pull request for ${e.project}: ${e.url}` : `Brought ${e.branch} home to ${e.project}`, at: e.at, ok: true });
    else if (e.type === "server.started") out.push({ id: `a${e.seq}`, role: "activity", text: `Serving http://127.0.0.1:${e.port}`, at: e.at, ok: true });
    else if (e.type === "homecopy.changed") out.push({ id: `a${e.seq}`, role: "activity", text: `Your home copy of ${e.project} changed underneath it`, at: e.at, ok: false });
  }
  return out;
}

function rule<T>(step: () => T): T {
  try { return step(); } catch (e) { throw e instanceof DesktopError ? new CodingDesktopError(e.message) : e; }
}
