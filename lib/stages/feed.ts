/** feed.ts — the classic chain's third stage: intake → memory → feed.
 *
 * The gardener files what arrived; memory keeps the working set; the feed
 * sorts what the gardener filed for the owner. For each conversation with
 * claims it has not yet read (lib/views/feedConversation.ts: a thread, or every
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
 * Its inputs are the live claims since `feed.since`, each with its
 * conversation, and a claim is settled once a successful call has read it
 * (the projection's feed_reads), so what is waiting is `waiting` over the
 * two (lib/stages/stage.ts): due whenever the gardener has filed claims the
 * feed hasn't sorted, so a run sorts what it just filed. Only a failed call
 * waits, one interval, so ticks never bill retries back to back.
 * `feed.since` bounds the backlog, so turning it on never bills the history. */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ownerLabelsFor } from "../assertionAgent";
import type { AssertionEvent } from "../assertionLog";
import { projectJournal, syncAssertionProjection } from "../assertionProjection";
import { scheduledVerdict, type StageVerdict } from "../chain";
import { ENGINE_ROOT } from "../engine";
import {
  FEED_JOURNAL_DIR, FEED_SECTIONS, feedItems, feedRecords,
  type FeedEntry, type FeedItem, type FeedRecord, type FeedSection,
} from "../feedJournal";
import { ensureDir, writeAtomic } from "../fsx";
import { sourceMoment } from "../insertionLog";
import type { FeedConfig, Manifest } from "../manifest";
import { memoryRead } from "../noteRead";
import { render } from "../prompts";
import { commitRunRecords } from "../runRecords";
import { modelRunJournalFields, newRunId } from "../run/journal";
import type { RunUsage } from "../run/model";
import { tryHold } from "../sqliteLock";
import { userIdentityOf, withSnapshot } from "../vaultReadModel";
import { feedConversationOf, feedConversationsOf, feedRead, type FeedConversation, type FeedMessage } from "../views/feedConversation";
import { plainText } from "../views/v2Feed";
import type { Snapshot } from "../views/view";
import { modelRunner } from "./runner";
import { waiting, type ModelRunner, type RecordStage, type RecordViews } from "./stage";

export const FEED_PROMPT_VERSION = "feed/v3";
const OFF = "off (no feed: block in vault.yaml)";


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

/** What the feed works on and has settled, as views: each live claim since
 * `since`, with its conversation, and the claims a call has read. */
function feedViews(since: string, owner: readonly string[]): RecordViews<FeedConversation, { assertion_id: string }> {
  return {
    output: "record",
    inputs: (snapshot) => feedConversationsOf(snapshot, since, owner)
      .flatMap((conversation) => claimsOf(conversation).map((a) => ({ id: a.id, hash: a.id, item: conversation }))),
    written: feedRead,
    settles: (out) => [out.assertion_id],
  };
}

/** Conversations with a live claim the feed has not read, each with ALL its
 * live claims since `since`: a conversation that gains a claim — a new
 * message, a meeting's next revision — is judged again, whole. Oldest
 * first. */
function waitingConversations(snapshot: Snapshot, since: string): FeedConversation[] {
  const owner = userIdentityOf(snapshot).map((d) => d.entity_id);
  const seen = new Map<string, FeedConversation>();
  for (const { item } of waiting(feedViews(since, owner), snapshot)) if (!seen.has(item.key)) seen.set(item.key, item);
  return [...seen.values()];
}

export function feedWork(root: string, cfg: FeedConfig): FeedConversation[] {
  syncAssertionProjection(root);
  return withSnapshot(root, (snapshot) => waitingConversations(snapshot, cfg.since));
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
      const n = feedWork(root, cfg).length;
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
  const rel = `${FEED_JOURNAL_DIR}/${month}/${record.invocation_id}.json`;
  writeAtomic(join(root, rel), `${JSON.stringify(record, null, 1)}\n`);
  projectJournal(root, rel); // the sorted feed is these
  commitRunRecords(root, { dir: FEED_JOURNAL_DIR, role: "feed", summary: `feed: call ${record.invocation_id}` });
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

export type FeedStage = RecordStage<FeedConversation, { assertion_id: string }> & { calls: FeedCall[] };

/** The stage for one run: the waiting conversations, oldest first, at most
 * `feed.max`, in calls of `feed.batch`. Each call is journaled as it lands,
 * so a killed run keeps every call that finished, and the next call's recent
 * headlines include what it just sorted. Its caller holds the feed's lock. */
export function feedStage(opts: { root: string; manifest: Manifest; cfg: FeedConfig; now: () => Date }): FeedStage {
  const { root, manifest, cfg, now } = opts;
  const stage: FeedStage = {
    ...feedViews(cfg.since, []), name: "feed", version: FEED_PROMPT_VERSION, calls: [],
    async run(context) {
      const model: ModelRunner | undefined = context.model;
      if (!model) throw new Error("feed: no model runner");
      const records = feedRecords(root);
      const { conversations, pending, journaled } = withSnapshot(root, (snapshot) => {
        const owner = userIdentityOf(snapshot).map((d) => d.entity_id);
        return {
          conversations: feedConversationsOf(snapshot, cfg.since, owner),
          pending: waitingConversations(snapshot, cfg.since).slice(0, cfg.max),
          journaled: feedConversationOf(snapshot, records.flatMap((r) => r.entries.map((e) => e.source))),
        };
      });
      if (!pending.length) return;
      const live = new Map(conversations.flatMap((c) => c.messages.map((m) => [m.id, c.key] as const)));
      const standing = new Set<string>(conversations.flatMap((c) => claimsOf(c).map((a) => a.id)));
      const conversationOf = (source: string) => live.get(source) ?? journaled(source);
      const instructions = render(template(), { OWNER: ownerLabelsFor(root)[0] ?? "the owner" });
      const memory = memoryRead(root);
      const workingSet = memory.status === 200 ? memory.text.trim() : "none yet";
      for (let i = 0; i < pending.length; i += cfg.batch) {
        const batch = pending.slice(i, i + cfg.batch);
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
          const run = await model({
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
          stage.calls.push({ runId, sources: batch.length, entries: entries.length, ...(run.usage ? { usage: run.usage } : {}) });
        } catch (e) {
          const message = (e instanceof Error ? e.message : String(e)).slice(0, 2_000);
          journalFeed(root, { ...base, assertions: [], entries: [], completed_at: now().toISOString(), error: { message } });
          stage.calls.push({ runId, sources: batch.length, entries: 0, error: message });
          break;
        }
      }
    },
  };
  return stage;
}

/** One run of the feed stage under its lock, handed the model runner. */
export async function runFeed(opts: { root: string; manifest: Manifest; runner?: ModelRunner; now?: () => Date }): Promise<FeedRunResult> {
  const { root, manifest } = opts;
  const cfg = manifest.feed;
  if (!cfg) return { ran: false, reason: OFF, calls: [] };
  ensureDir(join(root, ".state"));
  const lock = tryHold(feedLockFile(root), { name: "feed", retired: join(root, ".state", "feed.lock") });
  if (!lock) return { ran: false, reason: "another feed run holds the lock", calls: [] };
  try {
    const stage = feedStage({ root, manifest, cfg, now: opts.now ?? (() => new Date()) });
    await stage.run({ model: opts.runner ?? modelRunner(), write: { append() { /* each call journals what it read */ } } }, []);
    return { ran: true, calls: stage.calls };
  } finally {
    lock.release();
  }
}
