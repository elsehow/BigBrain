/** feedStage.ts — the classic chain's third stage: tend → memory → feed.
 *
 * The gardener files what arrived; memory keeps the working set; the feed
 * sorts what the gardener filed for the owner. For each source with claims
 * it has not yet read, one model call (batched) places the source in one
 * section — needs the owner, an agent could do it, worth knowing, or skip —
 * with a one-line headline and, when there is a deadline, an expiry date.
 *
 * It reads only its own chain's output: the live assertion log, the source
 * each assertion cites, and the working set (memory/MEMORY.md). It writes
 * only journal/feed/ (lib/feedJournal.ts) and never an assertion, so nothing
 * it judges comes back to any pass as evidence.
 *
 * A scheduled stage by the one rule (lib/chain.ts scheduledVerdict): due
 * when sources are waiting and the interval since the last call has passed.
 * `feed.since` bounds the backlog, so turning it on never bills the history. */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ownerLabelsFor } from "./assertionAgent";
import { assertionSourceReferences, readAssertionLog, type AssertionEvent } from "./assertionLog";
import { projectedSourcesById, syncAssertionProjection } from "./assertionProjection";
import { scheduledVerdict, type StageVerdict } from "./chain";
import { ENGINE_ROOT } from "./engine";
import {
  FEED_JOURNAL_DIR, FEED_SECTIONS, feedRecords, sortedAssertions,
  type FeedEntry, type FeedRecord, type FeedSection,
} from "./feedJournal";
import { ensureDir, writeAtomic } from "./fsx";
import type { SourceInsertion } from "./insertionLog";
import type { FeedConfig, Manifest } from "./manifest";
import { memoryRead } from "./noteRead";
import { acquire, release } from "./pidLock";
import { render } from "./prompts";
import { runAgent } from "./run/agent";
import { modelRunJournalFields, newRunId } from "./run/journal";
import type { RunUsage } from "./run/model";
import { plainText } from "./v2Feed";

export const FEED_PROMPT_VERSION = "feed/v1";
const OFF = "off (no feed: block in vault.yaml)";

type Runner = typeof runAgent;

const ENTRIES_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "integer" },
          section: { type: "string", enum: [...FEED_SECTIONS] },
          headline: { type: "string" },
          expires: { type: ["string", "null"] },
        },
        required: ["source", "section", "headline", "expires"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
};

// ── what is waiting ────────────────────────────────────────────────────────

/** Sources with a live claim the feed has not read, each with ALL its live
 * claims since `feed.since`: a source that gains a claim is judged again,
 * whole. Keyed by the insertion the claims cite (a legacy claim that cites
 * none stands alone). Oldest first. */
export function feedWork(root: string, cfg: FeedConfig, records: FeedRecord[] = feedRecords(root)): [string, AssertionEvent[]][] {
  const read = sortedAssertions(records);
  const groups = new Map<string, AssertionEvent[]>();
  for (const a of readAssertionLog(root)) {
    if (a.created_at < cfg.since) continue;
    const key = assertionSourceReferences(a)[0]?.insertion_id ?? a.id;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups].filter(([, claims]) => claims.some((a) => !read.has(a.id)));
}

/** The last call, failed or not, plus the interval: a failure waits a full
 * interval too, so ticks never bill retries back to back. */
export function feedNextRunAt(cfg: FeedConfig, records: FeedRecord[]): string {
  const last = records.at(-1);
  return last ? new Date(Date.parse(last.completed_at) + cfg.intervalMs).toISOString() : `${cfg.since}T00:00:00.000Z`;
}

export function feedDue(root: string, cfg: FeedConfig | undefined, opts: { force?: boolean; now?: Date } = {}): StageVerdict {
  if (!cfg) return { due: false, reason: OFF };
  const records = feedRecords(root);
  return scheduledVerdict({
    ...opts, nextRunAt: feedNextRunAt(cfg, records),
    work: () => {
      const n = feedWork(root, cfg, records).length;
      return n ? `${n} source(s) to sort` : undefined;
    },
    idle: "nothing new to sort",
  });
}

// ── one call ───────────────────────────────────────────────────────────────

const template = (): string => readFileSync(join(ENGINE_ROOT, "prompts", "feed.md"), "utf8");

/** One source as the call reads it: where it came from, then its claims. */
export function renderFeedSource(n: number, source: SourceInsertion | undefined, claims: AssertionEvent[]): string {
  const env = source?.envelope ?? {};
  const str = (k: string) => (typeof env[k] === "string" ? env[k] : "");
  const head = [
    `SOURCE ${n}`,
    `via: ${str("source") || str("kind")}`,
    `from_kind: ${str("from_kind")}`,
    `title: ${source?.title ?? ""}`,
    `date: ${(source?.occurred_at ?? source?.received_at ?? claims[0]!.created_at).slice(0, 10)}`,
  ];
  return [...head, ...claims.map((a) => `- ${plainText(a.text)}`)].join("\n");
}

/** The runner hands back schema-checked JSON (lib/run/sessionJob.ts); what
 * the schema cannot say — a source number in range, a real date — is
 * checked here. */
function parseEntries(text: string, batch: [string, AssertionEvent[]][]): FeedEntry[] {
  const value = JSON.parse(text) as { entries: { source: number; section: FeedSection; headline: string; expires: string | null }[] };
  const out: FeedEntry[] = [];
  for (const e of value.entries) {
    const group = batch[e.source - 1];
    if (!group || !e.headline.trim()) continue;
    out.push({
      source: group[0], section: e.section, headline: e.headline.trim(),
      expires: typeof e.expires === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.expires) ? e.expires : null,
      assertions: group[1].map((a) => a.id),
    });
  }
  return out;
}

function journalFeed(root: string, record: FeedRecord): void {
  const month = record.started_at.slice(0, 7);
  ensureDir(join(root, FEED_JOURNAL_DIR, month));
  writeAtomic(join(root, FEED_JOURNAL_DIR, month, `${record.invocation_id}.json`), `${JSON.stringify(record, null, 1)}\n`);
}

// ── the run ────────────────────────────────────────────────────────────────

export interface FeedCall {
  runId: string;
  sources: number;
  entries: number;
  usage?: RunUsage;
  error?: string;
}

export interface FeedRunResult {
  ran: boolean;
  reason?: string;
  calls: FeedCall[];
}

export const feedLockDir = (root: string): string => join(root, ".state", "feed.lock");

/** One run: the waiting sources, oldest first, at most `feed.max`, in calls
 * of `feed.batch`. Each call is journaled as it lands, so a killed run keeps
 * every call that finished. */
export async function runFeed(opts: { root: string; manifest: Manifest; runner?: Runner; now?: () => Date }): Promise<FeedRunResult> {
  const { root, manifest } = opts;
  const cfg = manifest.feed;
  if (!cfg) return { ran: false, reason: OFF, calls: [] };
  const now = opts.now ?? (() => new Date());
  const runner = opts.runner ?? runAgent;
  ensureDir(join(root, ".state"));
  if (!acquire(feedLockDir(root), "feed")) return { ran: false, reason: "another feed run holds the lock", calls: [] };
  try {
    const waiting = feedWork(root, cfg).slice(0, cfg.max);
    if (!waiting.length) return { ran: true, calls: [] };
    syncAssertionProjection(root); // the sources' titles and envelopes are read through it
    const sources = projectedSourcesById(root, waiting.map(([k]) => k));
    const instructions = render(template(), { OWNER: ownerLabelsFor(root)[0] ?? "the owner" });
    const memory = memoryRead(root);
    const workingSet = memory.status === 200 ? memory.text.trim() : "none yet";
    const calls: FeedCall[] = [];
    for (let i = 0; i < waiting.length; i += cfg.batch) {
      const batch = waiting.slice(i, i + cfg.batch);
      const runId = newRunId(now());
      const startedAt = now().toISOString();
      const prompt = [
        `TODAY ${now().toLocaleDateString("en-CA")}`, "", "WORKING SET", workingSet, "",
        ...batch.map(([key, claims], n) => `${renderFeedSource(n + 1, sources.get(key), claims)}\n`),
      ].join("\n");
      const base = {
        format: "bigbrain-feed-run/v1" as const, invocation_id: runId, prompt_version: FEED_PROMPT_VERSION,
        started_at: startedAt, model: cfg.target.model,
      };
      try {
        const run = await runner({
          root, role: "feed", auth: manifest.auth, target: cfg.target, capabilities: "none",
          instructions, prompt, output: { requireText: true, schema: ENTRIES_SCHEMA },
        });
        const entries = parseEntries(run.text, batch);
        journalFeed(root, {
          ...base, assertions: batch.flatMap(([, claims]) => claims.map((a) => a.id)), entries,
          completed_at: now().toISOString(), ...modelRunJournalFields(run) as { usage?: RunUsage },
        });
        calls.push({ runId, sources: batch.length, entries: entries.length, ...(run.usage ? { usage: run.usage } : {}) });
      } catch (e) {
        const message = (e instanceof Error ? e.message : String(e)).slice(0, 2_000);
        journalFeed(root, { ...base, assertions: [], entries: [], completed_at: now().toISOString(), error: { message } });
        calls.push({ runId, sources: batch.length, entries: 0, error: message });
        break;
      }
    }
    return { ran: true, calls };
  } finally {
    release(feedLockDir(root));
  }
}
