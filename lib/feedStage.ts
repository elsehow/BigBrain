/** feedStage.ts — the classic chain's third stage: tend → memory → feed.
 *
 * The gardener files what arrived; memory keeps the working set; the feed
 * sorts what the gardener filed for the owner. For each conversation with
 * claims it has not yet read (lib/feedConversation.ts: a thread, or every
 * landing of one source), one model call (batched) places it in one
 * section — needs the owner, an agent could do it, worth knowing, or skip —
 * with a one-line headline and the date anything is due by. The feed is
 * append-only (lib/feedJournal.ts feedItems): a call adds items, never
 * changes one. So each call sees the feed's ten newest headlines, and the
 * same story told again (another outlet, a column on it, a digest's recap)
 * is skipped, not announced twice; and a conversation judged again shows
 * the items it already has, so only what is new in it adds one.
 *
 * It reads only its own chain's output: the live assertions, the source
 * each assertion cites, and the working set (memory/MEMORY.md). It writes
 * only journal/feed/ (lib/feedJournal.ts) and never an assertion, so nothing
 * it judges comes back to any pass as evidence.
 *
 * Reactive: due whenever the gardener has filed claims it hasn't sorted, so
 * tend sorts what it just filed in the same run. Only a failed call waits,
 * one interval, so ticks never bill retries back to back.
 * `feed.since` bounds the backlog, so turning it on never bills the history. */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ownerLabelsFor } from "./assertionAgent";
import type { AssertionEvent } from "./assertionLog";
import { scheduledVerdict, type StageVerdict } from "./chain";
import { ENGINE_ROOT } from "./engine";
import { feedConversationOf, feedConversations, type FeedConversation, type FeedMessage } from "./feedConversation";
import {
  FEED_JOURNAL_DIR, FEED_SECTIONS, feedItems, feedRecords, sortedAssertions,
  type FeedEntry, type FeedItem, type FeedRecord, type FeedSection,
} from "./feedJournal";
import { ensureDir, writeAtomic } from "./fsx";
import { sourceMoment } from "./insertionLog";
import type { FeedConfig, Manifest } from "./manifest";
import { memoryRead } from "./noteRead";
import { render } from "./prompts";
import { runAgent } from "./run/agent";
import { modelRunJournalFields, newRunId } from "./run/journal";
import type { RunUsage } from "./run/model";
import { tryHold } from "./sqliteLock";
import { plainText } from "./v2Feed";

export const FEED_PROMPT_VERSION = "feed/v3";
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
          due: { type: ["string", "null"] },
        },
        required: ["source", "section", "headline", "due"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
};

// ── what is waiting ────────────────────────────────────────────────────────

const claimsOf = (c: FeedConversation): AssertionEvent[] => c.messages.flatMap((m) => m.claims);
/** The newest message: the one a conversation's feed entry names. */
const faceOf = (c: FeedConversation): FeedMessage => c.messages.at(-1)!;

/** Conversations with a live claim the feed has not read, each with ALL its
 * live claims since `feed.since`: a conversation that gains a claim — a new
 * message, a meeting's next revision — is judged again, whole. Oldest
 * first. */
export function feedWork(root: string, cfg: FeedConfig, records: FeedRecord[] = feedRecords(root)): FeedConversation[] {
  return waitingIn(feedConversations(root, cfg.since), records);
}

function waitingIn(conversations: FeedConversation[], records: FeedRecord[]): FeedConversation[] {
  const read = sortedAssertions(records);
  return conversations.filter((c) => claimsOf(c).some((a) => !read.has(a.id)));
}

/** Now, unless the last call failed: then one interval after it. */
export function feedNextRunAt(cfg: FeedConfig, records: FeedRecord[]): string {
  const last = records.at(-1);
  if (!last) return `${cfg.since}T00:00:00.000Z`;
  return last.error ? new Date(Date.parse(last.completed_at) + cfg.intervalMs).toISOString() : last.completed_at;
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

const claimLines = (m: FeedMessage): string[] => m.claims.map((a) => `- ${plainText(a.text)}`);

/** One conversation as the call reads it: where its newest message came
 * from, the items it already has in the feed, then its claims — message by
 * message, oldest first and each under its time and title, when there is
 * more than one. */
export function renderFeedSource(n: number, conversation: FeedConversation, told: readonly string[] = []): string {
  const { messages } = conversation, face = faceOf(conversation);
  const env = face.source?.envelope ?? {};
  const str = (k: string) => (typeof env[k] === "string" ? env[k] : "");
  const when = (m: FeedMessage) => m.source ? sourceMoment(m.source) : m.claims[0]!.created_at;
  const head = [
    `SOURCE ${n}`,
    `via: ${str("source") || str("kind")}`,
    `from_kind: ${str("from_kind")}`,
    `title: ${face.source?.title ?? ""}`,
    `date: ${when(face).slice(0, 10)}`,
    ...told.map((h) => `in the feed: ${h}`),
  ];
  if (messages.length === 1) return [...head, ...claimLines(face)].join("\n");
  return [...head, ...messages.flatMap((m) => [`[${when(m).slice(0, 16).replace("T", " ")}] ${m.source?.title ?? ""}`, ...claimLines(m)])].join("\n");
}

/** The feed's newest headlines, newest first, from items oldest first (as
 * feedItems gives them). Ten, so a story still reads as told when other
 * news landed in between. */
export const recentHeadlines = (items: readonly FeedItem[], n = 10): string[] =>
  items.slice(-n).reverse().map((e) => e.headline);

/** The runner hands back schema-checked JSON (lib/run/sessionJob.ts); what
 * the schema cannot say — a source number in range, a real date — is
 * checked here. */
function parseEntries(text: string, batch: FeedConversation[]): FeedEntry[] {
  const value = JSON.parse(text) as { entries: { source: number; section: FeedSection; headline: string; due: string | null }[] };
  const out: FeedEntry[] = [];
  for (const e of value.entries) {
    const conversation = batch[e.source - 1];
    if (!conversation || !e.headline.trim()) continue;
    out.push({
      source: faceOf(conversation).id, section: e.section, headline: e.headline.trim(),
      due: typeof e.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.due) ? e.due : null,
      assertions: claimsOf(conversation).map((a) => a.id),
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

export const feedLockFile = (root: string): string => join(root, ".state", "feed.lock.sqlite");

/** One run: the waiting conversations, oldest first, at most `feed.max`, in
 * calls of `feed.batch`. Each call is journaled as it lands, so a killed run
 * keeps every call that finished, and the next call's recent headlines
 * include what it just sorted. */
export async function runFeed(opts: { root: string; manifest: Manifest; runner?: Runner; now?: () => Date }): Promise<FeedRunResult> {
  const { root, manifest } = opts;
  const cfg = manifest.feed;
  if (!cfg) return { ran: false, reason: OFF, calls: [] };
  const now = opts.now ?? (() => new Date());
  const runner = opts.runner ?? runAgent;
  ensureDir(join(root, ".state"));
  const lock = tryHold(feedLockFile(root), { name: "feed", retired: join(root, ".state", "feed.lock") });
  if (!lock) return { ran: false, reason: "another feed run holds the lock", calls: [] };
  try {
    const records = feedRecords(root);
    const conversations = feedConversations(root, cfg.since);
    const waiting = waitingIn(conversations, records).slice(0, cfg.max);
    if (!waiting.length) return { ran: true, calls: [] };
    const live = new Map(conversations.flatMap((c) => c.messages.map((m) => [m.id, c.key] as const)));
    const standing = new Set(conversations.flatMap((c) => claimsOf(c).map((a) => a.id)));
    const journaled = feedConversationOf(root, records);
    const conversationOf = (source: string) => live.get(source) ?? journaled(source);
    const instructions = render(template(), { OWNER: ownerLabelsFor(root)[0] ?? "the owner" });
    const memory = memoryRead(root);
    const workingSet = memory.status === 200 ? memory.text.trim() : "none yet";
    const calls: FeedCall[] = [];
    for (let i = 0; i < waiting.length; i += cfg.batch) {
      const batch = waiting.slice(i, i + cfg.batch);
      const runId = newRunId(now());
      const startedAt = now().toISOString();
      const today = now().toLocaleDateString("en-CA");
      // what the viewer shows: an item whose claims were all revoked or
      // superseded since is gone from it, so it is no longer told
      const shown = feedItems(records).filter((e) => e.assertions.some((id) => standing.has(id)));
      const told = Map.groupBy(shown, (e) => conversationOf(e.source));
      const recent = recentHeadlines(shown);
      const prompt = [
        `TODAY ${today}`, "", "WORKING SET", workingSet, "",
        "ALREADY IN THE FEED", ...(recent.length ? recent.map((h) => `- ${h}`) : ["none yet"]), "",
        ...batch.map((c, n) => `${renderFeedSource(n + 1, c, (told.get(c.key) ?? []).map((e) => e.headline))}\n`),
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
        const record: FeedRecord = {
          ...base, assertions: batch.flatMap((c) => claimsOf(c).map((a) => a.id)), entries,
          completed_at: now().toISOString(), ...modelRunJournalFields(run) as { usage?: RunUsage },
        };
        journalFeed(root, record);
        records.push(record);
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
    lock.release();
  }
}
