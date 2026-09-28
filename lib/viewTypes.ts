/**
 * viewTypes.ts — the ONE declaration of the wire shapes the viewer's two
 * halves must agree on: web/server.ts (Bun, imports anything) and
 * web/ui/src (built by Vite — reachable across the repo root, since Vite's
 * default `fs.allow` walks up to the nearest `.git`, but only for a module
 * with no node:* imports anywhere in its graph). Both sides import from
 * here, so a field the server emits and the client's type doesn't know
 * about — or a narrower client union — is a compile error, not a drift
 * three people have to notice independently (#261).
 *
 * Pure by construction, same discipline as envelope.ts/noteMeta.ts: no
 * node:fs, no node:path, nothing that would break the browser bundle.
 * lib/queue.ts's QUEUE_STATES/QueueState live here for the same reason —
 * queue.ts itself imports node:fs and can't be reached from web/ui/src, so
 * it re-exports them from here instead of the other way around.
 */

import type { FilingStatus } from "./noteMeta";

export type { FilingStatus } from "./noteMeta";

/** A note's on-disk listing row (GET /api/notes). `title` and
 * `entity`/`entityType` are each present only when their source applies —
 * a bare /api/notes row carries `entity`/`entityType` when the file is a
 * `kind: entity` note, and never `title` (the desk routes that stamped it
 * died with #260; the field stays wire-contract for old payloads). */
export interface NoteMeta {
  name: string;
  path: string; // vault-root-relative, e.g. "references/2026-07-08-….md"
  modified: number;
  size: number;
  /** frontmatter `title:`, else the body's leading H1 (withTitle) —
   * no current route stamps this on a NoteMeta row. */
  title?: string;
  // Additive (phase 3): present only on `kind: entity` notes.
  entity?: true;
  entityType?: string;
}

// One row of the home feed (GET /api/recent): either a reference read
// straight off references/ (web/server.ts's recentFilesFromReferences) or a
// file's newest git touch (recentFilesFromGit), merged newest-first by
// lib/noteMeta.ts's mergeRecent. `modified` is the commit's authored time
// for a git row, the reference's own `received`/mtime for the other —
// git is the vault's clock; mtimes die on every clone/pull. `author` is the
// committer persona (triage / deep / config / a human) for a git row,
// "intake" for a reference row; `action` the humanized name-status letter.
export interface RecentEntry {
  /** Number of original messages in a virtual source thread. */
  threadCount?: number;
  path: string; // vault-root-relative note or immutable source-event path
  modified: number;
  author: string;
  action: string; // "added" | "edited" | "renamed" | "copied"
  title?: string;
  from?: string; // the sender, when provenance names one (email, agent, or service name)
  band: "person" | "agent" | "service" | "engine"; // you, your agents, feeds, or the machinery
  // Arrival rows only (phase 1): the frontmatter id (the dedup key against a
  // filed note) and its filing state — "pending" renders as the feed's
  // "filing…" affordance. "record" (Nick, 2026-08-13 decision): a user's
  // own words, home the moment they land — filingStatus() never returns it
  // itself, but it is part of the wire contract, and the UI must render it
  // rather than silently narrow the union.
  id?: string;
  /** Native lake identity. Present on source-log rows; `id` remains the
   * integration's stable source id used by queue joins. */
  insertionId?: string;
  status?: FilingStatus;
  /** The item's STRONG substrate type (source | reference | entity), declared at
   * delivery and stamped at landing (lib/envelope.ts's normalizeType).
   * Loosely typed on purpose: feedTag renders whatever string rides here
   * verbatim, not just the two landing ever actually stamps. */
  type?: string;
  /** Open descriptive tags beside the type (transcript, paper, dream, …). */
  tags?: string[];
  /** The reference's ONE category — landing-stamped from the door's flavor
   * word, editor-reassignable; the CATEGORY facet/column reads this (a
   * dossier's reads entityType instead). */
  category?: string;
  // The filed-by column's raw material (lib/feed.ts's filedByLabel maps
  // these to a channel/principal label, never an internal persona): the
  // intake token / integration name and the channel.
  via?: string; // frontmatter submitted_via
  source?: string; // frontmatter source (web / api / email / claude-code / granola …)
  /** Connector-specific provenance detail (email inbox, model, account). */
  sourceDetail?: string;
  /** Model used by an agent session, when the producer records it. */
  agentModel?: string;
  sessionId?: string;
  workId?: string;
  live?: "working" | "waiting";
  // Additive (phase 4): once an arrival row is filed, the citing note's own
  // path (lib/noteMeta.ts's mergeRecent) — the feed's collection chip.
  filedPath?: string;
  // The MODEL of the run that filed the note (triage_run → journal) — the
  // filed-by column's machine-author fallback; absent when unresolvable.
  filedModel?: string;
  // Additive (phase 3): present only on `kind: entity` notes.
  entity?: true;
  entityType?: string;
  /** An EXACT pointer at another item's `id` — the web drop zone stamps
   * `about: <the document's id>` on the note typed beside a file. */
  about?: string;
  /** The identifier a browser capture and its annotation genuinely share.
   * The extension mints no client id (landing dedup is the payload sha), so a
   * note and its page are linked by the page URL and nothing else. */
  url?: string;
  /** The item's opening words — what a NESTED row shows, since an
   * annotation's title is just "Note on: <its subject's title>". */
  excerpt?: string;
}

// The queue's four states — lib/queue.ts re-exports these (it can't be
// imported from web/ui/src; see the file header) and web/ui/src/lib/types.ts
// does the same, so both sides keep importing from their usual home.
export const QUEUE_STATES = ["pending", "running", "done", "failed"] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** What a queue message IS, read off its shape (phase 5 — no verbs):
 * guidance → a directive (a mind's intent), facts → a repair (runner-
 * computed), else an arrival to absorb. Legacy rows (pre-phase-5) carrying
 * a verb keep showing it verbatim — which is why the type stays genuinely
 * open (matching lib/envelope.ts's `ItemType | (string & {})` pattern)
 * rather than the closed three-value set it otherwise looks like. */
export type MessageKind = "arrival" | "directive" | "repair" | (string & {});

export function messageKind(m: {
  guidance?: string;
  facts?: unknown;
  verb?: string;
}): MessageKind {
  if (m.facts) return "repair";
  if (m.guidance) return "directive";
  return m.verb && m.verb !== "file" ? m.verb : "arrival";
}
