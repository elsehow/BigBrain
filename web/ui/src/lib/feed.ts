// Pure view logic for the home feed's collection chip (phase 4 item 2 of
// docs/plans/2026-07-25-lake-vault-queue.md) — split out of HomeView.svelte
// so it's testable with plain `bun test`.

import type { GraphNode, RecentEntry } from "./types";
import { INTERNAL_PERSONAS as INTERNAL } from "../../../../lib/personas";

/** The recent feed's ONE substrate: arrivals — native source-log rows on the
 * assertion architecture, legacy reference rows on a vault that has not
 * adopted it. A dossier the editor rewrote and a memory sweep's edit are not
 * arrivals a reader scans this table for; they have their own surfaces.
 *
 * Reads the STRONG type off the envelope, stamped at landing
 * (lib/envelope.ts's normalizeType) or the native log projection — never a path guess. That is also what
 * makes the filter total: git-reconstructed rows (entities/, domains/,
 * pre-envelope history) carry no `type` at all and drop out, and the server
 * never reconstructs a `references/` row from git in the first place. */
export function isReference(r: Pick<RecentEntry, "type">): boolean {
  return r.type === "reference" || r.type === "source";
}

/** The TRIAGED column's mark: a check (done) or the spinner (still
 * waiting), each with its own honest aria-label. "filed"/"declined" are
 * the editor's two ways of finishing a reference, shown identically (Nick,
 * 2026-08-12: a reader wants to know what still needs them, not why the
 * gardener passed). "record" (Nick, 2026-08-13 decision) is a THIRD, older
 * way to be done that isn't the gardener's doing at all — a user's own
 * words, home the moment they land — so it renders neutrally rather than
 * spinning forever (nothing is coming that would ever resolve it) or
 * borrowing the "filed" claim it never earned. Any other status
 * (pending, or none yet) still waits.
 *
 * The labels said "triaged — its links are built" / "not triaged yet"
 * until 2026-08-31 (#509): they named the retired triage pass, and the
 * links half was never true of the gardener, which writes assertions. */
export function filedMark(r: Pick<RecentEntry, "status">): { done: boolean; label: string } {
  if (r.status === "record") return { done: true, label: "a record — nothing to file" };
  if (r.status === "filed" || r.status === "declined")
    return { done: true, label: "filed — the record cites it" };
  return { done: false, label: "not filed yet" };
}

/** Recents omits only Pilot's own entries. The vault and graph retain them. */
export function visibleInRecents(r: FilerFacets): boolean {
  return r.source !== "pilot" && r.from !== "pilot" && filedByLabel(r).toLowerCase() !== "pilot";
}

// ── nesting: a note and the thing it is a note ON ──────────────────────────
// Two front doors emit an annotation beside the item it annotates, and both
// already write the link — it simply had no reader:
//
//   web drop zone   `kind: note`       + `about: <the document's id>`
//                   The client mints the id, stamps it on the file it ships
//                   and on the note typed beside it. An EXACT pointer; a
//                   dropped PDF has no URL, so identity is all there is.
//
//   browser ext.    `kind: annotation` + `url: <the page>`
//                   The extension deliberately mints NO client id — landing
//                   dedup is the payload sha, and a timestamped client id
//                   would make every re-clip of an unchanged page land as a
//                   fresh reference. So the page URL is the one identifier
//                   the capture and the note genuinely share.
//
// Left flat, the feed shows "Note on: X" directly above "X" — a row whose
// every word is already on the line below, pushing real arrivals down. So
// the note hangs under its subject instead.
//
// Two rules that must not bend:
//   · The GROUP sorts by its subject's `modified`, never a note's. A note is
//     a child; children don't reorder their parent, so annotating a
//     three-week-old clip does not resurface it. Each note keeps and shows
//     its OWN timestamp.
//   · A note whose subject isn't in the list stays a top-level row. Nesting
//     may reshape the feed; it may never make a row disappear from it.

export interface FeedGroup {
  row: RecentEntry;
  /** Oldest first, so a growing thread reads down the page. Empty for the
   * overwhelming majority of rows. */
  notes: RecentEntry[];
  /** Email threads keep older messages out of the main feed entirely. */
  collapsed?: boolean;
}

/** Does this row declare itself a note ON something? `about` says so
 * outright. The URL path additionally demands the annotation category —
 * without it two clips of the same page would nest into each other. `tags`
 * is checked beside `category` because the editor may reassign a category
 * but never rewrites the landing-stamped tag. */
function subjectOf(r: RecentEntry): { about?: string; url?: string } | null {
  if (r.about) return { about: r.about };
  const annotation = r.category === "annotation" || !!r.tags?.includes("annotation");
  if (annotation && r.url) return { url: r.url };
  return null;
}

/** Fold every note under the row it annotates, preserving feed order.
 * Pure: same input, same output — no clock, no DOM. */
export function nestNotes(rows: readonly RecentEntry[]): FeedGroup[] {
  const claims = new Map<RecentEntry, { about?: string; url?: string }>();
  for (const r of rows) {
    const s = subjectOf(r);
    if (s) claims.set(r, s);
  }

  // A note may never be a subject: one level only, and no cycle can form
  // (`about` chains, or a stray annotation carrying its subject's URL).
  const byId = new Map<string, RecentEntry>();
  const byUrl = new Map<string, RecentEntry>();
  for (const r of rows) {
    if (claims.has(r)) continue;
    if (r.id && !byId.has(r.id)) byId.set(r.id, r);
    // Newest wins, compared explicitly rather than trusting the caller's
    // order: re-clipping a CHANGED page yields two rows on one URL, and a
    // note written now belongs to the capture that prompted it.
    if (r.url) {
      const held = byUrl.get(r.url);
      if (!held || r.modified > held.modified) byUrl.set(r.url, r);
    }
  }

  const notesFor = new Map<RecentEntry, RecentEntry[]>();
  const adopted = new Set<RecentEntry>();

  // Email rows carrying the same Gmail thread URL are one conversation, not
  // separate recent items. Keep the newest message as the subject and hang
  // the older messages beneath it, using the same visual treatment as notes.
  const emailThreads = new Map<string, RecentEntry[]>();
  for (const r of rows) {
    if (claims.has(r) || r.source !== "email" || !r.url) continue;
    const list = emailThreads.get(r.url);
    if (list) list.push(r); else emailThreads.set(r.url, [r]);
  }
  for (const members of emailThreads.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => b.modified - a.modified);
    const parent = members[0]!;
    notesFor.set(parent, members.slice(1));
    // Mark the parent without changing the public row shape.
    for (const child of members.slice(1)) adopted.add(child);
  }
  for (const [note, s] of claims) {
    const parent = s.about ? byId.get(s.about) : byUrl.get(s.url!);
    if (!parent || parent === note) continue; // subject outside the window — the note stays a row of its own
    const list = notesFor.get(parent);
    if (list) list.push(note);
    else notesFor.set(parent, [note]);
    adopted.add(note);
  }

  const out: FeedGroup[] = [];
  for (const r of rows) {
    if (adopted.has(r)) continue;
    const notes = notesFor.get(r);
    const emailThread = r.source === "email" && !!r.url && (notes?.length ?? 0) > 0;
    out.push({ row: r, notes: emailThread ? [] : (notes ? [...notes].sort((a, b) => a.modified - b.modified) : []), ...(emailThread ? { collapsed: true } : {}) });
  }
  return out;
}

/** The label for a nested note row: the note's own opening words. Its TITLE
 * is "Note on: <the subject>" — the row directly above it — so echoing that
 * says nothing; a bare marker is more honest, and the note itself is one
 * click away. A note with a title of its own keeps it. */
export function noteLabel(n: Pick<RecentEntry, "excerpt" | "title">): string {
  const excerpt = (n.excerpt ?? "").trim();
  if (excerpt) return excerpt;
  const title = (n.title ?? "").trim();
  return !title || /^note on:/i.test(title) ? "note" : title;
}

/** Stable accent assignment for the mockup's chips: a filer or type name
 * hashes to one of the five token accents (--accent-1 … --accent-5) and
 * keeps that hue for life — deterministic, no registry to drift. Empty
 * names get 0: "no accent", the neutral chip fill. */
export function accentIndex(key: string): 0 | 1 | 2 | 3 | 4 | 5 {
  const k = key.trim().toLowerCase();
  if (!k) return 0;
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return ((h % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

/** Inline chip background per the mockup: an accent mixed 24% into the page,
 * or the neutral fill when nothing owns a hue. */
export function chipBg(accent: number): string {
  return accent >= 1 && accent <= 5
    ? `color-mix(in oklab, var(--accent-${accent}) 24%, var(--bg))`
    : "var(--chip-neutral)";
}

// ── filed-by: a channel or principal, never an internal persona ────────────
// The feed's FILED BY column answers "who put this in the vault" in words a
// person recognizes: the intake token / integration they used, their own
// name, the channel, or — for machine-synthesized notes — the model that did
// the work. The editor's internal personas (triage/deep/intake/…) belong to
// the audit surfaces (the system activity list, a note's TOUCHED BY), never
// here; when nothing user-facing resolves, the label is EMPTY and the row
// renders the no-filer variant rather than wearing a fabricated name.
//
// INTERNAL is lib/personas.ts's INTERNAL_PERSONAS (#265) — the one home,
// defined as the union of this file's old list and noteMeta's ENGINE_SOURCES.
const CHANNEL_LABELS: Record<string, string> = {
  web: "dropped", // the app's drop zone — what it is to the person, not the transport
  dropped: "dropped",
  api: "api",
  email: "email",
  "claude-code": "claude code",
  "deep-think": "Deep Think", // prototype integration — synthesis notes on top of the vault
};

const clean = (v: unknown): string => (typeof v === "string" && v.trim().toLowerCase() !== "n/a" ? v.trim() : "");
/** slugs read as words: "web-edge" → "web edge", "that-tracks" → "that tracks" */
const deslug = (s: string): string =>
  /^[a-z0-9]+(-[a-z0-9]+)+$/.test(s) ? s.replace(/-/g, " ") : s;

/** A model id as a short human label: "claude-haiku-4-5[-date]" → "haiku 4.5",
 * "claude-3-5-sonnet-20241022" → "sonnet 3.5". An id that doesn't parse is
 * shown verbatim — truthful, never invented. Module-private: filedByTitle
 * below is its one consumer (#260 retired the export). */
function modelLabel(id: string): string {
  const t = clean(id).toLowerCase();
  if (!t) return "";
  const fam = "opus|sonnet|haiku|fable";
  let m = new RegExp(`(?:^|-)(${fam})-(\\d)(?:[-.](\\d))?(?:$|-)`).exec(t);
  if (m) return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  m = new RegExp(`(?:^|-)(\\d)(?:[-.](\\d))?-(${fam})(?:$|-)`).exec(t);
  if (m) return `${m[3]} ${m[1]}${m[2] ? `.${m[2]}` : ""}`;
  m = new RegExp(`(?:^|-)(${fam})(?:$|-)`).exec(t);
  if (m) return m[1]!;
  return t;
}

/** A person's `from` as a short principal: an email collapses to its first
 * name-ish segment ("ada.b.lovelace@…" → "ada"); anything else is shown
 * as it declared itself (deslugged when it's a slug). */
function principal(from: string): string {
  const at = from.indexOf("@");
  if (at > 0) {
    const local = from.slice(0, at);
    return local.split(".")[0] || local;
  }
  return deslug(from);
}

/** The FILED BY cell. Precedence: the intake token / integration name
 * (`submitted_via`) → the principal (`from`) → the channel (`source`,
 * mapped to its friendly label) → "BigBrain" for the machine's own work
 * (a filedModel resolved from the journal, or a row the editor authored).
 * The product name, not a model id: the journal retains the exact model
 * and capability per run for the audit surfaces, and filedByTitle below
 * carries it into the chip's tooltip. Internal personas never surface
 * from any field; "" means "no filer" — render the empty-cell variant. */
/** The fields the filer helpers read. A feed row carries them all; a
 * search hit carries just the stamped subset (web/server.ts /api/search),
 * so the same filter can govern both. */
export type FilerFacets = Partial<
  Pick<RecentEntry, "via" | "from" | "source" | "sourceDetail" | "filedModel" | "agentModel" | "author" | "band" | "type">
>;

export function filedByLabel(r: FilerFacets): string {
  const via = clean(r.via);
  if (via && !INTERNAL.has(via)) return CHANNEL_LABELS[via] ?? deslug(via);
  const from = clean(r.from);
  if (from && !INTERNAL.has(from)) return CHANNEL_LABELS[from] ?? principal(from);
  const source = clean(r.source);
  if (source && !INTERNAL.has(source)) return CHANNEL_LABELS[source] ?? deslug(source);
  if (clean(r.filedModel)) return "BigBrain";
  if (clean(r.author) === "editor") return "BigBrain";
  return "";
}

/** The feed's two provenance facets: connector/provider first, then the
 * principal or worker model carried by that connector. */
export function sourceLabel(r: FilerFacets): string {
  const via = clean(r.via);
  if (via && !INTERNAL.has(via)) return CHANNEL_LABELS[via] ?? deslug(via);
  const source = clean(r.source);
  return source && !INTERNAL.has(source) ? CHANNEL_LABELS[source] ?? deslug(source) : filedByLabel(r);
}
export function tagLabel(r: FilerFacets): string {
  const model = agentModelLabel(r);
  if (model) return model;
  const detail = clean(r.sourceDetail);
  if (detail) return detail;
  const from = clean(r.from), source = sourceLabel(r);
  // `from: codex` says which agent submitted an older direct drop. It is
  // not a model name, so leave this cell empty until real model provenance
  // arrives rather than presenting the provider as though it were one.
  if (r.band === "agent" && !clean(r.agentModel)) return "";
  return from && !INTERNAL.has(from) && deslug(from) !== source.toLowerCase() ? principal(from) : "";
}

/** The worker's own model, never the gardener that later filed its output. */
export function agentModelLabel(r: FilerFacets): string {
  const model = clean(r.agentModel);
  if (model) return modelLabel(model);
  const from = clean(r.from), provider = filedByLabel(r);
  // Older agent drops may declare their composer in `from`.
  return r.band === "agent" && ["codex", "claude code"].includes(provider)
    && from && !INTERNAL.has(from) && deslug(from.toLowerCase()) !== provider ? from : "";
}

/** Agent drops retain their declared composer/model behind the stable
 * connector chip. The gardener's journal model describes a different run. */
export function filedByTitle(r: FilerFacets): string {
  const filer = filedByLabel(r);
  const from = clean(r.from);
  if (filer === "codex" || filer === "claude code") {
    return r.band === "agent" && from && !INTERNAL.has(from) &&
      deslug(from.toLowerCase()) !== filer
      ? `Filed by ${filer} — ${from}`
      : `Filed by ${filer}`;
  }
  const model = clean(r.filedModel);
  return model ? `Filed by BigBrain (${modelLabel(model)})` : "";
}

// ── the FILED BY filter (Nick, 2026-08-20) ─────────────────────────────────
// One filter over both of the home screen's surfaces: the chip list is
// populated from whatever filers the client has actually loaded — feed rows
// AND graph nodes, since either can know a filer the other doesn't (the feed
// is paged; the graph draws only linked arrivals) — and the OFF set it
// produces filters the rows and hides the matching graph nodes. Connected
// agents start OFF: a vault's own agent chatter is volume, not signal, until
// asked for. Everything here is pure; HomeView owns the state and the
// localStorage round-trip.

/** What one graph node offers the filter — the filer fields (absent on
 * view-tree notes) plus `entity`, which exempts a node from filtering
 * entirely (a dossier is nobody's filing). */
export type FilerNode = Pick<GraphNode, "band" | "via" | "from" | "source" | "entity">;

export interface FilerChip {
  label: string;
  /** Any row or node wearing this label is band "agent" — the chips that
   * default OFF. */
  agent: boolean;
}

/** A graph node through the row labeller: same precedence, same internal-
 * persona guard, so a node and its feed row can never disagree on the chip. */
const nodeLabel = (n: FilerNode): string =>
  filedByLabel({ via: n.via, from: n.from, source: n.source, author: "" });

/** Every filer present in what's loaded, sorted by name. */
export function filerChips(rows: readonly FilerFacets[], nodes: readonly FilerNode[]): FilerChip[] {
  const labels = new Set<string>();
  const agents = new Set<string>();
  const add = (label: string, band?: string): void => {
    if (!label || UNCHIPPED.has(label)) return; // no filer resolved (or the grouped legacy family) — never a chip, never filtered
    labels.add(label);
    if (band === "agent") agents.add(label);
  };
  for (const r of rows) if (isReference(r)) add(filedByLabel(r), r.band);
  for (const n of nodes) if (!n.entity) add(nodeLabel(n), n.band);
  return [...labels].sort().map((label) => ({ label, agent: agents.has(label) }));
}

/** Effective on/off for one chip: the user's explicit choice wins; absent
 * one, agents are off and everything else is on. Choices are stored per
 * LABEL, so a filer the user has never touched keeps following the default —
 * including an agent that connects for the first time next week. */
/** The product's own doors, always ON by default (Nick, 2026-08-20) —
 * whatever band their rows wear. This exists for one reason: the hosted
 * era's feedback door delivered through an AGENT-kind token (tokens
 * only come in agent/person-device, and its delivery credential was
 * neither a person nor absent), so its rows are band "agent" and the
 * agents-off default would swallow the product's own feedback. These are
 * integrations, not the user's agent sessions; the labels are the ones
 * their stamps deslug to. */
const DEFAULT_ON = new Set(["bigbrain feedback", "browser extension", "granola", "dropped"]);

/** The grouped legacy family (lib/sourceFeed.ts: the mail door, cli drops,
 * retired credential names, pre-name API tokens). Not a connector, so not
 * a chip (Nick, 2026-08-27): its rows and nodes simply always show — a
 * label with no chip is never in the OFF set. */
const UNCHIPPED = new Set(["other"]);

export function filerOn(
  chip: FilerChip,
  choices: Readonly<Record<string, boolean>>
): boolean {
  return choices[chip.label] ?? (DEFAULT_ON.has(chip.label) || !chip.agent);
}

/** The OFF set — the one predicate both surfaces share. */
export function offFilers(
  chips: readonly FilerChip[],
  choices: Readonly<Record<string, boolean>>
): Set<string> {
  return new Set(chips.filter((c) => !filerOn(c, choices)).map((c) => c.label));
}

/** Row survives the filter? Rows with no filer label are never filtered —
 * there is no chip that could turn them back on. */
export function filerAllows(r: FilerFacets, off: ReadonlySet<string>): boolean {
  if (!off.size) return true;
  const label = filedByLabel(r);
  return !label || !off.has(label);
}

/** The graph-node ids the OFF set hides. Entities are exempt (they stay as
 * the map's landmarks; only the arrivals grounding them come and go), as is
 * any node with no filer label. */
export function hiddenFilerNodeIds(
  nodes: readonly (FilerNode & Pick<GraphNode, "id">)[],
  off: ReadonlySet<string>
): Set<string> {
  const out = new Set<string>();
  if (!off.size) return out;
  for (const n of nodes) {
    if (n.entity) continue;
    const label = nodeLabel(n);
    if (label && off.has(label)) out.add(n.id);
  }
  return out;
}
