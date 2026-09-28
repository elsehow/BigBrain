import { readHistoryIndex } from "./applicationHistoryIndex";
import { readFileSync } from "node:fs";
/** Read-only legacy session archive. Native agent sessions are stored separately. */
interface AgentLaunchSettings { executable: string; directory: string | null; permissionMode?: string }
export interface NativePermissionSummary {
  profile?: string;
  sandbox: string;
  approvals: string;
  onPrompt?: string;
  reviewer?: string;
  network?: string;
  writableFolders: string[];
  allow?: string[];
  ask?: string[];
  deny?: string[];
  sources?: string[];
  observedAt: string;
}

import { basename, join } from "node:path";
import { z } from "zod";
import { type SessionLoadIssue } from "./sessionRecords";
import { spoolDir } from "./spool";
import { writeAtomic } from "./fsx";
import type { ChatImage } from "./chatImageTypes";
import { sessionAccessSchema, type SessionAccess } from "./workAccess";
import { readWorkOutputs, type WorkOutput } from "./workOutputs";
export type WorkProvider = "codex" | "claude-code" | "pi";
export interface WorkContext { requestKey?: string; nodes?: string[]; node?: string; title?: string; text?: string; session?: string; cwd?: string }
export interface WorkMessage { images?: ChatImage[]; id: string; role: "user" | "agent" | "activity"; text: string; at: string }
export interface WorkSession {
  revision?: number;
  /** Archive intent retained after retiring the worker runtime. */
  archivedAt?: string;
  worker?: import("./worker/types").WorkerRecord["worker"];
  /** External execution is owned by a native runtime, never BB folder grants. */
  external?: { archivedAt?: string; launch?: AgentLaunchSettings; permissions?: NativePermissionSummary; adapter: WorkProvider; connected: boolean; nativeAttention?: string;
    question?: { id: string; text: string }; capabilities: { open: "attach" | "resume"; interrupt: boolean; followUp: boolean; steer?: boolean } };
  /** Historical record is retained; all further interaction belongs to this Pilot. */
  migratedToPilot?: string;
  id: string; title: string; cwd: string; provider: WorkProvider; thread?: string; turn?: string;
  status: "starting" | "working" | "needs-input" | "idle" | "interrupted" | "failed" | "terminal";
  vault?: string;
  choice?: import("./modelChoice").ModelChoice;
  model?: string;
  requestedModel?: string;
  origin?: { pilot: string; message: string };
  outputs?: WorkOutput[];
  completions?: { key: string; kind: "completed" | "failed"; text: string; at: string; model?: string; outputs: WorkOutput[] }[];
  lastActivityAt?: string;
  /** Legacy snapshot, read only during migration. */
  permissions?: { directories: string[]; cowboy: boolean };
  access?: SessionAccess;
  context: WorkContext; created: string; updated: string; messages: WorkMessage[];
  completion?: { key: string; kind: "completed" | "failed"; text: string; announced?: boolean };
  handoffId?: string;
  terminalReceipt?: string;
  observeCommand?: string;
  error?: string; pending?: { key?: string; announced?: boolean; id: string | number; method: string; params: any };
  receipts: string[];
  cancelRequested?: boolean;
  pendingQueue?: NonNullable<WorkSession["pending"]>[];
}
export { workSummary, workDetail, type WorkSummary } from "./workViews";
import { workSummary, type WorkSummary } from "./workViews";

export const savedWork = z.object({
  archivedAt: z.string().optional(),
  external: z.object({
    adapter: z.enum(["codex","claude-code"]), connected: z.boolean(),
    archivedAt: z.string().optional(),
    launch: z.object({ executable: z.string(), directory: z.string().nullable() }).optional(),
    permissions: z.object({ sandbox: z.string(), approvals: z.string(), writableFolders: z.array(z.string()), observedAt: z.string(),
      profile: z.string().optional(), reviewer: z.string().optional(), network: z.string().optional() }).optional(),
    capabilities: z.object({ open: z.enum(["attach","resume"]), interrupt: z.boolean(), followUp: z.boolean(), steer: z.boolean().optional() }),
    question: z.object({ id: z.string(), text: z.string() }).optional(), nativeAttention: z.string().optional(),
  }).optional(),
  id: z.string(), title: z.string(), created: z.string(), updated: z.string(),
  cwd: z.string(), provider: z.enum(["codex", "claude-code"]), receipts: z.array(z.string()),
  status: z.enum(["starting", "working", "needs-input", "idle", "interrupted", "failed", "terminal"]),
  context: z.object({ node: z.string().optional(), nodes: z.array(z.string()).optional() }).passthrough(),
  messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "agent", "activity"]), text: z.string(), at: z.string() }).passthrough()),
  access: sessionAccessSchema.optional(),
  origin: z.object({ pilot: z.string(), message: z.string() }).passthrough().optional(),
  outputs: z.array(z.object({ path: z.string(), title: z.string(), at: z.string() }).passthrough()).optional(),
}).passthrough();

export class WorkHistory {
  readonly loadIssues: SessionLoadIssue[] = [];
  private jobs = new Map<string, WorkSession>();
  private archives = new Map<string, { file: string; kind: "work-sessions" | "external-agents" | "handoffs"; summary: WorkSummary }>();
  get rootPath(): string { return this.root; }
  constructor(private root: string, private options: { observeRead?: (bytes: number) => void } = {}) {
    for (const kind of ["work-sessions", "external-agents", "handoffs"] as const) {
      const directory = join(spoolDir(root), kind);
      try {
        const index = readHistoryIndex(root, kind + "-v1", directory, kind === "handoffs" ? /^handoff-[a-f0-9]{32}\.json$/ : /^work-[a-f0-9]{32}\.json$/, file => {
          const job = this.readArchive(file, kind);
          return { group: "archive", order: job.updated, summary: workSummary(job) };
        });
        for (const file of index.problems) this.loadIssues.push({ file: join(directory, file), message: "Conversation could not be loaded. Its saved record has been preserved." });
        for (const row of index.rows) if (!this.archives.has(row.summary.id))
          this.archives.set(row.summary.id, { file: join(directory, row.file), kind, summary: row.summary });
      } catch { this.loadIssues.push({ file: directory, message: "Conversation folder could not be read. Its files have been preserved." }); }
    }
  }
  private readArchive(file: string, kind: "work-sessions" | "external-agents" | "handoffs"): WorkSession {
    const raw = readFileSync(file, "utf8"); this.options.observeRead?.(Buffer.byteLength(raw));
    let value = JSON.parse(raw);
    let id = basename(file, ".json");
    if (kind === "handoffs") {
      const job = value as import("./handoff").HandoffJob;
      if (!job || job.id !== id || typeof job.request?.task !== "string"
        || typeof job.request.user_words !== "string" || typeof job.request.created_at !== "string" || typeof job.updated_at !== "string"
        || job.result && (typeof job.result.title !== "string" || typeof job.result.answer !== "string")) throw new Error("Invalid historical research");
      id = job.id.replace(/^handoff-/, "work-");
      value = { id, handoffId: job.id, provider: "claude-code", title: job.result?.title ?? job.request.task,
        cwd: job.inspection?.working_directory ?? "", thread: job.session, status: job.status === "completed" ? "idle" : "interrupted",
        context: job.request.selection ?? {}, created: job.request.created_at, updated: job.updated_at, receipts: [],
        messages: [{ id: `${id}-user`, role: "user", text: job.request.user_words, at: job.request.created_at },
          ...(job.result ? [{ id: `${id}-answer`, role: "agent", text: job.result.answer, at: job.updated_at }] : [])] };
    }
    const job = savedWork.parse(value) as WorkSession;
    if (job.id !== id) throw new Error("Invalid historical conversation identity");
    if (kind === "external-agents" && job.external) {
      job.external.archivedAt ??= job.updated; job.external.connected = false;
      delete job.external.question; delete job.external.nativeAttention;
    }
    workSummary({ ...job, outputs: readWorkOutputs(this.root, job.id) });
    if (typeof job.worker?.archivedAt === "string") job.archivedAt ??= job.worker.archivedAt;
    delete job.worker; // archive bytes cannot create a live worker
    if (["starting", "working", "needs-input"].includes(job.status)) job.status = "interrupted";
    return job;
  }
  get(id: string): WorkSession {
    let job = this.jobs.get(id);
    if (!job) {
      const archive = this.archives.get(id);
      if (!archive) throw new Error("Historical session not found");
      job = this.readArchive(archive.file, archive.kind);
      this.jobs.set(id, job); this.archives.delete(id);
    }
    const outputs = readWorkOutputs(this.root, id);
    return { ...job, outputs: outputs.length ? outputs : job.outputs ?? [] };
  }
  list(): WorkSummary[] {
    return [...[...this.archives.values()].map(a => a.summary), ...[...this.jobs.values()].map(workSummary)].map(summary => {
      const outputs = readWorkOutputs(this.root, summary.id);
      return outputs.length ? { ...summary, outputs } : summary;
    }).sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
  }
  migrated(id: string, pilot: string): void {
    if ((this.archives.get(id)?.summary ?? this.jobs.get(id))?.migratedToPilot === pilot) return;
    const job = this.get(id);
    job.migratedToPilot = pilot; this.jobs.set(id, job);
    writeAtomic(join(spoolDir(this.root), "work-sessions", `${id}.json`), JSON.stringify(job), 0o600);
  }
}

export interface HistoricalWorkerReport {
  key: string; work: string; title: string; kind: "started" | "question" | "completed" | "failed"; text: string; at: string;
  /** Frozen public application transcript, not provider-private reasoning. */
  transcript?: { status: "available"; messages: WorkMessage[] } | { status: "unavailable"; reason: string };
}
