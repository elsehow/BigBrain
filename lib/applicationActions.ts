import { actionObservations } from "./actionInspection";
import { readHistoryIndex } from "./applicationHistoryIndex";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { basename, join } from "node:path";
import { sha256hex } from "./hash";
import { writeAtomic } from "./fsx";
import { spoolDir } from "./spool";

export type ActionActor = { kind: "pilot" | "user"; id: string };
export interface ActionRequest {
  actor: ActionActor;
  /** Host-selected logical delivery identity; never a credential or permission. */
  request: string;
  operation: string;
  scope: string[];
  payload: unknown;
}
export interface ActionReceipt {
  version: 1; id: string; actor: ActionActor; request: string; operation: string; scope: string[]; fingerprint: string;
  status: "prepared" | "executing" | "completed" | "failed" | "uncertain";
  created: string; updated: string; result?: unknown; error?: string;
}
const savedReceipt = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/),
  actor: z.object({ kind: z.enum(["pilot", "user"]), id: z.string().min(1) }),
  request: z.string().min(1).max(500), operation: z.string().min(1), scope: z.array(z.string()),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["prepared", "executing", "completed", "failed", "uncertain"]),
  created: z.string().refine(v => Number.isFinite(Date.parse(v))),
  updated: z.string().refine(v => Number.isFinite(Date.parse(v))),
  result: z.unknown().optional(), error: z.string().optional(),
});
export interface ActionHistoryIssue { kind: "receipt" | "directory"; count: number; message: string }
export interface ActionHistory { receipts: ActionReceipt[]; complete: boolean; issues: ActionHistoryIssue[]; nextCursor?: string }
export interface ActionHistoryQuery { limit?: number; cursor?: string }
const unreadable = () => new Error("Application action receipt is unreadable; execution is blocked.");
export function canonicalAction(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)])) : v;
  return JSON.stringify(normalize(value));
}
export class ActionOutcomeError extends Error {
  constructor(readonly receipt: ActionReceipt) { super(receipt.error ?? "This action is still pending or has an uncertain outcome. Inspect its receipt before requesting new work."); }
}
/** One application owner. Execution is always supplied by a trusted host adapter. */
export class ApplicationActions {
  private directory: string;
  private running = new Map<string, Promise<unknown>>();
  constructor(private root: string, private options: { now?: () => string; observeRead?: (bytes: number) => void; write?: (path: string, receipt: ActionReceipt) => void } = {}) {
    this.directory = join(spoolDir(root), "application-actions");
  }
  private at() { return this.options.now?.() ?? new Date().toISOString(); }
  private save(receipt: ActionReceipt): void {
    const path = join(this.directory, `${receipt.id}.json`);
    if (this.options.write) this.options.write(path, structuredClone(receipt));
    else writeAtomic(path, JSON.stringify(receipt), 0o600);
  }
  private read(id: string): ActionReceipt | undefined {
    const path = join(this.directory, `${id}.json`);
    let raw: string;
    try { raw = readFileSync(path, "utf8"); this.options.observeRead?.(Buffer.byteLength(raw)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw unreadable(); }
    let value: ActionReceipt;
    try {
      value = savedReceipt.parse(JSON.parse(raw));
      if (value.id !== id || sha256hex(canonicalAction([value.actor, value.request])) !== id) throw unreadable();
    } catch { throw unreadable(); }
    // A process-local promise is the only evidence execution is still alive.
    if (value.status === "executing" && !this.running.has(id)) { value.status = "uncertain"; value.updated = this.at(); this.save(value); }
    return value;
  }
  list(actor: ActionActor, query: ActionHistoryQuery = {}): ActionHistory {
    const limit = query.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Choose between 1 and 200 action records.");
    const group = canonicalAction(actor), context = sha256hex(canonicalAction([this.root, actor]));
    let after: { order: string; file: string } | undefined;
    if (query.cursor) {
      try {
        const value = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
        if (value.context !== context || typeof value.order !== "string" || !/^[a-f0-9]{64}\.json$/.test(value.file)) throw new Error();
        after = { order: value.order, file: value.file };
      } catch { throw new Error("Invalid action history cursor."); }
    }
    const history: ActionHistory = { receipts: [], complete: true, issues: [] };
    let page;
    try {
      page = readHistoryIndex(this.root, "actions-v1", this.directory, /^[a-f0-9]{64}\.json$/, file => {
        const receipt = this.read(basename(file, ".json"));
        if (!receipt) throw unreadable();
        return { group: canonicalAction(receipt.actor), order: receipt.created, summary: { id: receipt.id } };
      }, { group, limit, after });
    } catch {
      return { ...history, complete: false, issues: [{ kind: "directory", count: 1,
        message: "Action history could not be read. Saved actions have been preserved; missing results do not establish that an action did not happen." }] };
    }
    let damaged = page.damaged;
    for (const row of page.rows) {
      try {
        const receipt = this.read(basename(row.file, ".json"));
        if (!receipt || canonicalAction(receipt.actor) !== group) { damaged++; continue; }
        history.receipts.push(receipt);
      } catch { damaged++; }
    }
    if (damaged) {
      history.complete = false;
      history.issues.push({ kind: "receipt", count: damaged,
        message: "Some action records could not be read. Their bytes have been preserved and their execution remains blocked. Missing results do not establish that an action did not happen." });
    }
    const last = page.rows.at(-1);
    if (page.more && last) history.nextCursor = Buffer.from(JSON.stringify({ context, order: last.order, file: last.file })).toString("base64url");
    return history;
  }
  /** An unreadable modern record still owns its identity over legacy history. */
  hasIdentity(actor: ActionActor, request: string): boolean {
    return existsSync(join(this.directory, sha256hex(canonicalAction([actor, request])) + ".json"));
  }
  execute<T>(request: ActionRequest, host: {
    authorize: () => void | Promise<void>; validate?: () => void; execute: () => Promise<T> | T; signal?: AbortSignal;
    /** Historical receipts are read-only input; the first import becomes authoritative here. */
    legacy?: { status: "pending" | "done"; result?: unknown };
  }): Promise<T> {
    if (!request.request || request.request.length > 500 || !request.operation || !request.actor.id || !["pilot", "user"].includes(request.actor.kind)) return Promise.reject(new Error("Invalid application action identity."));
    const id = sha256hex(canonicalAction([request.actor, request.request]));
    const fingerprint = sha256hex(canonicalAction([request.operation, request.scope, request.payload]));
    const run = async (): Promise<T> => {
      host.signal?.throwIfAborted(); await host.authorize(); host.signal?.throwIfAborted();
      const prior = this.read(id);
      if (prior && prior.fingerprint !== fingerprint) throw new Error("This action identity already belongs to a different request.");
      if (prior?.status === "executing") { prior.status = "uncertain"; prior.updated = this.at(); this.save(prior); }
      if (prior?.status === "completed") return structuredClone(prior.result) as T;
      if (prior && ["failed", "uncertain", "executing"].includes(prior.status)) throw new ActionOutcomeError(prior);
      const at = this.at();
      const receipt: ActionReceipt = prior ?? { version: 1, id, actor: { ...request.actor }, request: request.request, operation: request.operation, scope: [...request.scope], fingerprint, status: "prepared", created: at, updated: at };
      if (!prior && host.legacy) {
        receipt.status = host.legacy.status === "done" ? "completed" : "uncertain";
        receipt.result = host.legacy.result; this.save(receipt);
        if (receipt.status === "completed") return structuredClone(receipt.result) as T;
        throw new ActionOutcomeError(receipt);
      }
      this.save(receipt); // No operation has been invoked: a prepared receipt is safe to resume.
      try { host.signal?.throwIfAborted(); host.validate?.(); await host.authorize(); host.signal?.throwIfAborted(); }
      catch (error) { receipt.status = "failed"; receipt.error = error instanceof Error ? error.message : "Action authorization failed."; receipt.updated = this.at(); this.save(receipt); throw error; }
      receipt.status = "executing"; receipt.updated = this.at(); this.save(receipt);
      let result: T;
      try { result = await host.execute(); }
      catch {
        receipt.status = "uncertain"; receipt.error = "The operation did not return a confirmed outcome. Inspect existing results before requesting it again."; receipt.updated = this.at();
        this.save(receipt); throw new ActionOutcomeError(receipt);
      }
      // Failure to save here leaves executing on disk: restart must not replay it.
      receipt.status = "completed"; receipt.result = result; receipt.updated = this.at(); this.save(receipt);
      return result;
    };
    const existing = this.running.get(id);
    if (existing) return (async () => {
      host.signal?.throwIfAborted(); await host.authorize();
      // Compare with the original delivery before joining its in-flight promise.
      if (this.fingerprints.get(id) !== fingerprint) throw new Error("This action identity already belongs to a different request.");
      return existing as Promise<T>;
    })();
    const task = Promise.resolve().then(run).finally(() => { this.running.delete(id); this.fingerprints.delete(id); });
    this.fingerprints.set(id, fingerprint); this.running.set(id, task); return task;
  }
  private fingerprints = new Map<string, string>();
}

export function actionReceiptView(r: ActionReceipt) {
  return { id: r.id, actor: { kind: r.actor.kind, id: r.actor.id }, request: r.request, operation: r.operation,
    scope: [...r.scope], status: r.status, created: r.created, updated: r.updated, error: r.error, observations: actionObservations(r) };
}
export function userActionId(value: unknown): string {
  if (value === undefined) return crypto.randomUUID(); // Older callers are new requests, never inferred retries.
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,200}$/.test(value)) throw new Error("Invalid action request identity.");
  return value;
}

export function actionHistoryQuery(params: URLSearchParams): ActionHistoryQuery {
  return { limit: params.has("limit") ? Number(params.get("limit")) : undefined, cursor: params.get("cursor") ?? undefined };
}
