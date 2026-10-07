/** readLog.ts — who read what through BigBrain's live integrations.
 *
 * Every call the dispatcher ends (lib/integrationTools.ts) is one line of a
 * log kept on the host, outside the vault and outside agents' reach:
 * ~/.config/bigbrain/reads/<vault-hash>/YYYY-MM.jsonl (the token store's
 * hash; a file per UTC month), owner-only, months that ended more than 90
 * days ago pruned as it writes. A line says who asked and what they were
 * called then, which integration, account and tool, the arguments in
 * summary, how the call ended and how long it took, and how much came back:
 * its size, its entries, how many credentials were withheld from it and
 * sign-in messages held. Never what came back, and never a credential.
 *
 * Pilot's engine and every client's `bigbrain mcp` append to the same file,
 * each line in one write() of a file opened O_APPEND and kept under 4 KiB,
 * so lines from different processes never interleave. Writing never fails a
 * read: a failure is said once on stderr and the read goes on. Settings reads
 * the log back (lib/readLogRoutes.ts); docs/self-host.md says what it holds. */
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { listTokens, tokenStorePath } from "./auth";
import { countWithheld, screenCredentials } from "./credentialScreen";
import { configDir } from "./engine";
import { readLogOverride } from "./env";
import { makePrivate } from "./fsx";
import { sha256hex } from "./hash";
import { observeIntegrationCalls, type IntegrationCall } from "./integrationTools";

export const READ_LOG_RETENTION_DAYS = 90;
/** A line is one write(); far below this, appends from several processes cannot interleave. */
const MAX_LINE = 4096;

/** One live integration call, as the log keeps it. */
export interface ReadRecord {
  /** When the call began. */
  ts: string;
  /** As grants name them (`pilot`, `token:<id>`), or the caller's kind when it could not be identified. */
  caller: string;
  /** What the caller was called when it asked: Pilot, or the client connection's name. */
  label: string;
  integration: string;
  /** Empty when the call was refused before an account was resolved. */
  account: string;
  tool: string;
  /** In summary: strings clipped, credentials withheld; refs and ids kept. */
  args: Record<string, unknown>;
  outcome: "ok" | "refused" | "error";
  error?: string;
  ms: number;
  /** What came back, measured: its JSON size, the entries of its lists. */
  bytes?: number;
  items?: number;
  /** Credentials withheld from it and sign-in messages held back, when any were. */
  withheld?: number;
  held?: number;
  /** This caller's first successful call on this integration. */
  first?: true;
  /** For `bigbrain mcp`: the program that started it. */
  parent?: { pid: number; command: string };
}

/** Where a vault's read log lives, or BIGBRAIN_READ_LOG's folder. */
export function readLogDir(root: string): string {
  return readLogOverride() ?? join(configDir(), "reads", sha256hex(root).slice(0, 12));
}

// ── what a line may say ─────────────────────────────────────────────────────

const WITHHELD = "[withheld]";
/** Credential shapes withheld wherever they appear: BigBrain's own tokens, authorization values, `secret=` pairs, well-known key prefixes, JWTs. */
const SHAPES = [
  /\bbb_[0-9a-f]{8}_[\w-]+/gu,
  /\b(?:bearer|basic)\s+[\w.~+/=-]{8,}/giu,
  /\b(?:password|passwd|pwd|passcode|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie)\b["']?\s*[:=]\s*\S+/giu,
  /\b(?:sk|rk|pk)-[\w-]{16,}/gu,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abposr])[_-][\w-]{10,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bAIza[\w-]{30,}/gu,
  /\bya29\.[\w-]{10,}/gu,
  /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/gu,
];
/** Opaque strings that read like a secret: long, mixed-case letters with digits, or long hex. Not for refs and ids, which are opaque on purpose. */
const OPAQUE = [/(?<![\w+/=-])(?=[\w+/=-]*\d)(?=[\w+/=-]*[a-z])(?=[\w+/=-]*[A-Z])[\w+/=-]{20,}/gu, /\b[0-9a-f]{32,}\b/giu];
/** An app password, spaced or not. Only in errors: in a query it is four ordinary words. */
const APP_PASSWORD = /\b[a-z]{4}(?: ?[a-z]{4}){3}\b/gu;

function scrub(text: string, as: "text" | "id" | "error" = "text"): string {
  let out = as === "id" ? text : screenCredentials(text, { where: "not logged" }).text;
  for (const shape of SHAPES) out = out.replace(shape, WITHHELD);
  if (as !== "id") for (const shape of OPAQUE) out = out.replace(shape, WITHHELD);
  return as === "error" ? out.replace(APP_PASSWORD, WITHHELD) : out;
}
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "…" : s);

const ID_KEY = /^(?:ref|id|uid|uidvalidity)$|_(?:id|ref|uid|uidvalidity)$/u;
/** Arguments as the log keeps them: credentials withheld, strings clipped
 * (refs and ids to a longer bound, whole in practice), at most 20 keys and 10
 * list entries, three levels deep. */
export function argsSummary(args: Record<string, unknown>, room = { text: 200, id: 512 }): Record<string, unknown> {
  const walk = (v: unknown, key: string, depth: number): unknown => {
    if (typeof v === "string") return ID_KEY.test(key) ? clip(scrub(v, "id"), room.id) : clip(scrub(v), room.text);
    if (v === null || typeof v === "number" || typeof v === "boolean") return v;
    if (Array.isArray(v)) {
      const head = v.slice(0, 10).map(x => walk(x, key, depth + 1));
      return v.length > 10 ? [...head, `… ${v.length - 10} more`] : head;
    }
    if (typeof v !== "object") return typeof v;
    if (depth >= 3) return "{…}";
    const entries = Object.entries(v as Record<string, unknown>);
    const out: Record<string, unknown> = Object.fromEntries(entries.slice(0, 20).map(([k, x]) => [clip(scrub(k), 64), walk(x, k, depth + 1)]));
    if (entries.length > 20) out["…"] = `${entries.length - 20} more`;
    return out;
  };
  return walk(args, "", 0) as Record<string, unknown>;
}

/** What came back, measured and let go: its size, the entries of its lists,
 * and the markers lib/agentReads.ts leaves where it withheld a credential or
 * held a sign-in message. */
export function measured(result: unknown): Pick<ReadRecord, "bytes" | "items" | "withheld" | "held"> {
  let withheld = 0, held = 0;
  const walk = (v: unknown, depth: number): void => {
    if (typeof v === "string") { withheld += countWithheld(v); return; }
    if (!v || typeof v !== "object" || depth > 64) return;
    if (!Array.isArray(v) && typeof (v as { held?: unknown }).held === "string") held++;
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(result, 0);
  let bytes: number | undefined;
  try { bytes = Buffer.byteLength(JSON.stringify(result) ?? ""); } catch { /* unmeasurable */ }
  const inner = result && typeof result === "object" && "result" in result ? (result as { result: unknown }).result : result;
  const items = Array.isArray(inner) ? inner.length
    : inner && typeof inner === "object" ? Object.values(inner).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0) : undefined;
  return { ...(bytes !== undefined ? { bytes } : {}), ...(items !== undefined ? { items } : {}), ...(withheld ? { withheld } : {}), ...(held ? { held } : {}) };
}

/** A call as one line of the log: nothing of its result but measures, and short enough to append in one write. */
export function readRecord(call: IntegrationCall, who: { label: string; parent?: ReadRecord["parent"] }): ReadRecord {
  const base = (args: Record<string, unknown>): ReadRecord => ({
    ts: call.at, caller: clip(call.caller, 80), label: clip(who.label, 120), integration: clip(call.integration, 64),
    account: clip(scrub(call.account), 254), tool: clip(scrub(call.tool), 64), args, outcome: call.outcome,
    ...(call.error ? { error: clip(scrub(call.error, "error"), 300) } : {}), ms: call.ms,
    ...(call.outcome === "ok" ? measured(call.result) : {}), ...(who.parent ? { parent: who.parent } : {}),
  });
  // room for `first`, added as it is written
  const fits = (r: ReadRecord) => Buffer.byteLength(JSON.stringify(r)) < MAX_LINE - 64;
  const record = base(argsSummary(call.args));
  if (fits(record)) return record;
  const tighter = base(argsSummary(call.args, { text: 40, id: 80 }));
  return fits(tighter) ? tighter : base({ "…": "arguments too long to log" });
}

// ── writing ─────────────────────────────────────────────────────────────────

const MONTH = /^(\d{4})-(\d{2})\.jsonl$/u;
const FIRSTS = "firsts.jsonl";
const pair = (caller: string, integration: string): string => `${caller}\n${integration}`;

/** A JSONL file's lines that parse, in order; a line that never finished is passed over. */
function jsonLines(file: string): unknown[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  return text.split("\n").flatMap(line => { if (!line) return []; try { return [JSON.parse(line)]; } catch { return []; } });
}
function appendLine(file: string, line: string): void {
  const fd = openSync(file, "a", 0o600);
  try { writeSync(fd, line); } finally { closeSync(fd); }
}
/** Months that ended more than the retention period ago. */
function prune(dir: string, now: number): void {
  for (const name of readdirSync(dir)) {
    const m = MONTH.exec(name);
    if (!m || now - Date.UTC(Number(m[1]), Number(m[2]), 1) <= READ_LOG_RETENTION_DAYS * 86_400_000) continue;
    try { unlinkSync(join(dir, name)); } catch { /* another process pruned it */ }
  }
}
/** Each caller's first successful call per integration: one line apiece,
 * never pruned, so a first read is known after its month is gone. Two
 * processes may both claim one; the earlier stands. */
function firsts(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of jsonLines(join(dir, FIRSTS)) as { caller?: unknown; integration?: unknown; ts?: unknown }[]) {
    if (typeof v?.caller !== "string" || typeof v.integration !== "string" || typeof v.ts !== "string") continue;
    const k = pair(v.caller, v.integration), prior = out.get(k);
    if (!prior || v.ts < prior) out.set(k, v.ts);
  }
  return out;
}

const pruned = new Map<string, number>(), claimed = new Map<string, Set<string>>();
function claimFirst(dir: string, r: ReadRecord): boolean {
  const k = pair(r.caller, r.integration);
  if (claimed.get(dir)?.has(k)) return false;
  // not yet this process's: another may have claimed it since
  const known = new Set(firsts(dir).keys());
  claimed.set(dir, known);
  if (known.has(k)) return false;
  appendLine(join(dir, FIRSTS), JSON.stringify({ ts: r.ts, caller: r.caller, integration: r.integration }) + "\n");
  known.add(k);
  return true;
}

/** Append one record to `dir`'s month file, pruning old months at most hourly. Throws; the observer swallows. */
export function appendRead(dir: string, record: ReadRecord, now = Date.now()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!pruned.has(dir)) makePrivate(dir);
  if (now - (pruned.get(dir) ?? -Infinity) > 3_600_000) { prune(dir, now); pruned.set(dir, now); }
  const line = record.outcome === "ok" && claimFirst(dir, record) ? { ...record, first: true as const } : record;
  appendLine(join(dir, `${record.ts.slice(0, 7)}.jsonl`), JSON.stringify(line) + "\n");
}

/** What the caller was called when it asked. */
function callerLabel(root: string, caller: string): string {
  if (caller === "pilot") return "Pilot";
  if (caller === "worker") return "Project worker";
  if (caller === "gardener") return "Gardener";
  if (!caller.startsWith("token:")) return "Unidentified client";
  const id = caller.slice("token:".length);
  try { const name = listTokens(tokenStorePath(root)).find(t => t.id === id)?.name; if (name) return name; } catch { /* unreadable store: by its id */ }
  return `Connection ${id}`;
}

let parent: ReadRecord["parent"];
/** The program that started this `bigbrain mcp`: its parent, or past the
 * `bigbrain` command (this same runtime) to the client that ran that. Asked once. */
export function mcpParent(): NonNullable<ReadRecord["parent"]> {
  if (parent) return parent;
  const ask = (pid: number): { ppid: number; command: string } | undefined => {
    try {
      const m = /^\s*(\d+)\s+(.+)$/su.exec(execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }));
      return m ? { ppid: Number(m[1]), command: m[2]!.trim() } : undefined;
    } catch { return undefined; }
  };
  let pid = process.ppid, seen = ask(pid);
  if (seen && basename(seen.command) === basename(process.execPath) && seen.ppid > 1) {
    const up = ask(seen.ppid);
    if (up) { pid = seen.ppid; seen = up; }
  }
  return (parent = { pid, command: seen ? clip(basename(seen.command), 64) : "" });
}

/** Log every live integration call this process dispatches for `root`;
 * `mcp` notes the client program that started this server. Returns the way to stop. */
export function logIntegrationCalls(root: string, options: { mcp?: boolean } = {}): () => void {
  let said = false;
  return observeIntegrationCalls(call => {
    try {
      appendRead(readLogDir(root), readRecord(call, { label: callerLabel(root, call.caller), ...(options.mcp ? { parent: mcpParent() } : {}) }));
    } catch (error) {
      if (said) return;
      said = true;
      console.error(`read log: a live integration call went unrecorded (${error instanceof Error ? error.message : String(error)}); reads go on.`);
    }
  });
}

// ── reading ─────────────────────────────────────────────────────────────────

const OUTCOMES = new Set(["ok", "refused", "error"]);
/** Every retained record, newest month and line first. */
function* newestFirst(dir: string): Generator<ReadRecord> {
  let names: string[];
  try { names = readdirSync(dir).filter(n => MONTH.test(n)).sort().reverse(); } catch { return; }
  for (const name of names)
    for (const r of (jsonLines(join(dir, name)) as Partial<ReadRecord>[]).reverse())
      if (typeof r?.ts === "string" && typeof r.caller === "string" && typeof r.integration === "string" && typeof r.tool === "string" && OUTCOMES.has(r.outcome!)) yield r as ReadRecord;
}

/** An account's latest records, newest first, each caller's first read of the
 * integration marked. A call refused before its account was resolved counts
 * for the account it named. */
export function recentReads(root: string, integration: string, account: string, limit = 50): ReadRecord[] {
  const dir = readLogDir(root), first = firsts(dir), out: ReadRecord[] = [];
  const named = (r: ReadRecord) => typeof r.args?.account === "string" && r.args.account.toLowerCase() === account.toLowerCase();
  for (const r of newestFirst(dir)) {
    if (r.integration !== integration || (r.account ? r.account !== account : !named(r))) continue;
    const { first: _claimed, ...rest } = r;
    out.push(r.outcome === "ok" && first.get(pair(r.caller, r.integration)) === r.ts ? { ...rest, first: true } : rest);
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

/** Each caller's latest successful call: when, and on which integration. */
export function lastReads(root: string): Map<string, { ts: string; integration: string }> {
  const out = new Map<string, { ts: string; integration: string }>();
  for (const r of newestFirst(readLogDir(root))) {
    const prior = out.get(r.caller);
    if (r.outcome === "ok" && (!prior || prior.ts < r.ts)) out.set(r.caller, { ts: r.ts, integration: r.integration });
  }
  return out;
}
