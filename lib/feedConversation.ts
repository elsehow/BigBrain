/** feedConversation.ts — what the feed (lib/feedStage.ts) judges: a
 * conversation, not an arrival.
 *
 * Every landing of one source (a meeting's revisions, lib/sourceSupersede.ts)
 * and every message of one thread (lib/sourceThreads.ts: their mail, your
 * drafts, what you sent) is ONE conversation: judged whole, newest message
 * last, and holding one place in the feed. Judged an arrival at a time, a
 * reply saved as several drafts was several entries asking you to send it,
 * beside the one saying you had, and a meeting re-sent on every edit was an
 * entry per edit.
 *
 * Read from the projection only, so a superseded landing's claims are
 * already hidden and a thread is the read model's thread. */

import type { Database } from "bun:sqlite";
import { assertionSourceReferences, type AssertionEvent } from "./assertionLog";
import type { FeedRecord } from "./feedJournal";
import type { SourceMetadata } from "./insertionLog";
import { liveAssertionSql, liveSourceSql } from "./sourceSupersede";
import { sourceTime } from "./sourceThreads";
import { withVaultSnapshot } from "./vaultReadModel";

/** One message: a source and the live claims filed from it. */
export interface FeedMessage {
  /** The insertion id, or the claim's own id for a legacy claim citing none. */
  id: string;
  source?: SourceMetadata;
  claims: AssertionEvent[];
}

export interface FeedConversation {
  key: string;
  /** Oldest first. The newest is the conversation's face: the feed entry
   * names it as its `source`. */
  messages: FeedMessage[];
}

interface SourceRow { insertion_id: string; source_id: string; thread: string | null; live: number; header_json: string }

/** A thread of one message is no conversation: it keys by its source. */
const THREADS = "SELECT thread_id FROM read_thread_members GROUP BY thread_id HAVING count(*) > 1";

function sourceRows(db: Database, ids: readonly string[]): Map<string, SourceRow> {
  const rows = db.query(`SELECT s.insertion_id, s.source_id, s.header_json, m.thread_id AS thread, ${liveSourceSql("s")} AS live
    FROM sources s LEFT JOIN read_thread_members m ON m.insertion_id = s.insertion_id AND m.thread_id IN (${THREADS})
    WHERE s.insertion_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as SourceRow[];
  return new Map(rows.map((r) => [r.insertion_id, r]));
}

const keyOf = (row: SourceRow | undefined, id: string): string => row?.thread ?? row?.source_id ?? id;
const moment = (m: FeedMessage): number => (m.source ? sourceTime(m.source) : 0) || Date.parse(m.claims[0]!.created_at);

/** Every conversation with a live claim since `since`, each with all of its
 * live claims since then. Oldest first, by first claim. */
export function feedConversations(root: string, since: string): FeedConversation[] {
  return withVaultSnapshot(root, (db) => {
    const claims = (db.query(`SELECT a.event_json FROM assertions a
      WHERE a.revoked_by IS NULL AND a.created_at >= ? AND ${liveAssertionSql("a")} ORDER BY a.created_at, a.id`)
      .all(since) as { event_json: string }[]).map((r) => JSON.parse(r.event_json) as AssertionEvent);
    const cited = claims.map((a) => assertionSourceReferences(a).map((r) => r.insertion_id));
    const sources = sourceRows(db, [...new Set(cited.flat())]);
    const conversations = new Map<string, Map<string, FeedMessage>>();
    claims.forEach((a, i) => {
      const refs = cited[i]!;
      const id = refs.find((r) => sources.get(r)?.live) ?? refs[0] ?? a.id;
      const row = sources.get(id);
      const key = keyOf(row, id);
      const messages = conversations.get(key) ?? new Map<string, FeedMessage>();
      conversations.set(key, messages);
      const message = messages.get(id) ?? { id, ...(row ? { source: JSON.parse(row.header_json) as SourceMetadata } : {}), claims: [] };
      messages.set(id, message);
      message.claims.push(a);
    });
    return [...conversations].map(([key, messages]) => ({
      key, messages: [...messages.values()].sort((a, b) => moment(a) - moment(b) || a.id.localeCompare(b.id)),
    }));
  });
}

/** Each journaled entry's conversation, for reading the feed: the journal
 * names an entry by its face, and an older entry in the same conversation
 * is the same place in the feed. */
export function feedConversationOf(root: string, records: readonly FeedRecord[]): (source: string) => string {
  const ids = [...new Set(records.flatMap((r) => r.entries.map((e) => e.source)))];
  if (!ids.length) return (id) => id;
  const rows = withVaultSnapshot(root, (db) => sourceRows(db, ids));
  return (id) => keyOf(rows.get(id), id);
}
