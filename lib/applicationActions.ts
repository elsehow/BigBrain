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
/** Where a request stopped: before a durable receipt, in pre-dispatch checks, or in dispatch itself. */
export type ActionStage = "request" | "validate" | "authorize" | "execute";
/** An identity the operation created, recorded before its reply is confirmed. */
export interface ActionEffect { agent?: string }
export interface ActionReceipt {
  version: 1; id: string; actor: ActionActor; request: string; operation: string; scope: string[]; fingerprint: string;
  status: "prepared" | "executing" | "completed" | "failed" | "uncertain";
  created: string; updated: string; result?: unknown; error?: string;
  /** The underlying failure, kept as evidence beside the verdict; never a replacement for it. */
  stage?: ActionStage; cause?: string; observed?: ActionEffect;
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
  stage: z.enum(["request", "validate", "authorize", "execute"]).optional(), cause: z.string().max(2000).optional(),
  observed: z.object({ agent: z.string().regex(/^work-[a-f0-9]{32}$/).optional() }).strict().optional(),
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
const UNCERTAIN = "The operation did not return a confirmed outcome. Inspect existing results before requesting it again.";
const causeOf = (error: unknown) => (error instanceof Error && error.message ? error.message : "Action failed.").slice(0, 2000);
/** A host's proof that it refused before invoking any effect: the receipt fails and a retry is safe. */
export class ActionRefusal extends Error {}
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
  /** One of this actor's receipts by ID; another actor's reads as absent. */
  owned(actor: ActionActor, id: string): ActionReceipt | undefined {
    const receipt = /^[a-f0-9]{64}$/.test(id) ? this.read(id) : undefined;
    return receipt && canonicalAction(receipt.actor) === canonicalAction(actor) ? receipt : undefined;
  }
  /** The durable receipt for exactly this request, if one was recorded. */
  receipt(request: ActionRequest): ActionReceipt | undefined {
    const prior = this.read(sha256hex(canonicalAction([request.actor, request.request])));
    return prior?.fingerprint === sha256hex(canonicalAction([request.operation, request.scope, request.payload])) ? prior : undefined;
  }
  /** Durable evidence of the effect settles an uncertain receipt. Nothing is executed or replayed. */
  resolve(receipt: ActionReceipt, result: unknown): ActionReceipt { return receipt.status !== "uncertain" || this.running.has(receipt.id) ? receipt : this.settle(receipt, result); }
  private settle(receipt: ActionReceipt, result: unknown): ActionReceipt {
    const next: ActionReceipt = { ...structuredClone(receipt), status: "completed", result, updated: this.at() };
    delete next.error; this.save(next); return next;
  }
  execute<T>(request: ActionRequest, host: {
    authorize: () => void | Promise<void>; validate?: () => void | Promise<void>; signal?: AbortSignal;
    /** `observe` records a created identity while the outcome is still unconfirmed. */
    execute: (action: { id: string; observe: (effect: ActionEffect) => void }) => Promise<T> | T;
    /** Settle an uncertain prior receipt from durable evidence; undefined keeps it uncertain. */
    recover?: (receipt: ActionReceipt) => unknown;
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
      if (prior?.status === "uncertain") {
        const recovered = host.recover?.(prior);
        if (recovered !== undefined) return structuredClone(this.settle(prior, recovered).result) as T;
      }
      if (prior && ["uncertain", "executing"].includes(prior.status)) throw new ActionOutcomeError(prior);
      const at = this.at();
      const receipt: ActionReceipt = prior ?? { version: 1, id, actor: { ...request.actor }, request: request.request, operation: request.operation, scope: [...request.scope], fingerprint, status: "prepared", created: at, updated: at };
      // A failed receipt never dispatched anything, so the same identity may try again.
      if (prior?.status === "failed") { receipt.status = "prepared"; receipt.updated = at; delete receipt.error; delete receipt.stage; delete receipt.cause; }
      if (!prior && host.legacy) {
        receipt.status = host.legacy.status === "done" ? "completed" : "uncertain";
        receipt.result = host.legacy.result; this.save(receipt);
        if (receipt.status === "completed") return structuredClone(receipt.result) as T;
        throw new ActionOutcomeError(receipt);
      }
      this.save(receipt); // No operation has been invoked: a prepared receipt is safe to resume.
      let stage: ActionStage = "validate";
      try { host.signal?.throwIfAborted(); await host.validate?.(); stage = "authorize"; await host.authorize(); host.signal?.throwIfAborted(); }
      catch (error) { receipt.status = "failed"; receipt.error = error instanceof Error ? error.message : "Action authorization failed."; receipt.stage = stage; receipt.cause = causeOf(error); receipt.updated = this.at(); this.save(receipt); throw error; }
      receipt.status = "executing"; receipt.updated = this.at(); this.save(receipt);
      const observe = (effect: ActionEffect) => {
        receipt.observed = { ...receipt.observed, ...effect }; receipt.updated = this.at();
        try { this.save(receipt); } catch { /* The terminal save carries it; the effect must not be reported as failed. */ }
      };
      let result: T;
      try { result = await host.execute({ id, observe }); }
      catch (error) {
        const refused = error instanceof ActionRefusal && !receipt.observed;
        receipt.status = refused ? "failed" : "uncertain"; receipt.stage = "execute"; receipt.cause = causeOf(error);
        receipt.error = refused ? receipt.cause : UNCERTAIN; receipt.updated = this.at();
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
    scope: [...r.scope], status: r.status, created: r.created, updated: r.updated, error: r.error, stage: r.stage, cause: r.cause, observations: actionObservations(r) };
}
/** A failed action's reply: its durable handle, verdict, and whether re-issuing it could duplicate an effect.
 * `receipt` null means the durable record could not be read, which blocks retry. */
export function actionFailure(operation: string, error: unknown, receipt: ActionReceipt | undefined | null) {
  const message = error instanceof Error ? error.message : "Application action failed.";
  const safe = receipt !== null && (!receipt || receipt.status === "failed" || receipt.status === "prepared");
  const cause = receipt?.cause ?? (receipt ? undefined : message);
  return { error: receipt?.error ?? message, ...(receipt ? { request: receipt.id } : {}), operation, status: safe ? "failed" as const : "unknown" as const,
    stage: receipt?.stage ?? (receipt && !safe ? "execute" : "request"), retry: safe ? "safe" as const : "blocked" as const,
    ...(cause && cause !== (receipt?.error ?? message) ? { cause } : {}), ...(receipt?.observed?.agent ? { agent: receipt.observed.agent } : {}) };
}
export function userActionId(value: unknown): string {
  if (value === undefined) return crypto.randomUUID(); // Older callers are new requests, never inferred retries.
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,200}$/.test(value)) throw new Error("Invalid action request identity.");
  return value;
}

export function actionHistoryQuery(params: URLSearchParams): ActionHistoryQuery {
  return { limit: params.has("limit") ? Number(params.get("limit")) : undefined, cursor: params.get("cursor") ?? undefined };
}
