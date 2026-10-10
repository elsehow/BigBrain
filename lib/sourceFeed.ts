import { background } from "./readModelBackground";
import { preparedFeedPage, currentReadRevision } from "./vaultReadModel";
/** User-facing rows and reads over the native append-only source log.
 *
 * This is a projection, not a second copy of the source. The virtual note
 * path names the immutable JSON event on disk; the viewer renders its
 * discussable title/body without requiring a references/ compatibility file.
 */
import type { SourceSummary } from "./sourceSummary";
export { sourceExcerpt } from "./sourceSummary";
import { sourceRecord, readFeedPage, type SourceRecord } from "./vaultReadModel";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "./engine";
import { RETIRED_INTEGRATIONS } from "./personas";
import type { Envelope } from "./envelope";
import {
  insertionEventRel, sourceMoment,
  type EventAuthor,
  type SourceMetadata, type SourceInsertion,
} from "./insertionLog";
import { supersededInsertionIds } from "./sourceSupersede";
import { fmProvenance, type FilingStatus } from "./noteMeta";
import type { RecentEntry } from "./viewTypes";
import { savedClaudeModel } from "./sourceModel";
import { sourceOrigin } from "./sourceOrigin";

const sourcePath = /^log\/insertions\/(?:\d{4}-\d{2}|undated)\/(ins_[a-f0-9]{24})\.json$/u;
const scalar = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() || undefined : undefined;
const timestamp = (source: SourceMetadata): number => Date.parse(sourceMoment(source)) || 0;
const authorBand = (author: EventAuthor): RecentEntry["band"] => {
  if (author.kind === "user") return "person";
  if (author.kind === "agent" || author.kind === "model") return "agent";
  return "service";
};

/** Stable, user-facing delivery family. Connection-card names remain in the
 * immutable envelope/canonical-filer event for audit, but they are too
 * granular for a durable filter: "chrome" and "zen browser 2026-08" are
 * credentials for the same browser-extension door, and a hostname is not a
 * different Claude Code product. Rules use structured channel/principal
 * fields, plus the canonical connection name for legacy API arrivals that
 * predate the agent-chat channel, rather than an alias list of historical
 * display names.
 *
 * FILED BY is a connector filter, not a provenance enumeration (Nick's
 * live staging review, 2026-08-21, on #433): only current connector
 * families are first-class. Legacy and one-off arrival routes — the mail
 * door, cli drops, retired connection-card names like "nick laptop", bare
 * pre-name API tokens — all project to the single grouped family "other".
 * Their exact envelope/canonical provenance is untouched underneath; only
 * the filter-facing name collapses. "import" stays its own family: the
 * archive importer is one consistent identity, explicitly not drift. */
const CONNECTOR_FAMILIES = new Set([
  "granola", "dropped", "import", "browser extension", "bigbrain feedback",
]);

/** Every integration the engine ships (`integrations/<name>/`), minus the
 * retired. An integration IS a source (Nick, 2026-09-04: email's first
 * landings wore "other"), so each is a FILED BY family of its own, named
 * for itself, with no hand list here to fall behind. agent-chat is the one
 * exception, handled first below: its rows are named for the agent. */
let shipped: ReadonlySet<string> | undefined;
function shippedIntegrations(): ReadonlySet<string> {
  if (!shipped) {
    try {
      shipped = new Set(
        readdirSync(join(ENGINE_ROOT, "integrations"), { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => d.name)
          .filter((n) => !RETIRED_INTEGRATIONS.has(n))
      );
    } catch {
      shipped = new Set();
    }
  }
  return shipped;
}

const BROWSER_VIA = /^(chrome|chromium|firefox|zen|edge|brave|arc|safari|opera|vivaldi|browser)\b/;

export function projectedFilerName(envelope: Envelope): string {
  const channel = scalar(envelope.source)?.toLocaleLowerCase();
  const from = scalar(envelope.from)?.toLocaleLowerCase();
  const recordedVia = scalar(envelope.submitted_via)?.trim().toLocaleLowerCase();
  // Codex drops use its own credential; older drops can also identify the
  // composer in `from` on a shared API token. Check before agent-chat's
  // legacy Claude fallback so Codex transcripts keep their own identity too.
  if (channel === "codex" || /^codex\b/.test(recordedVia ?? "") ||
      ((scalar(envelope.from_kind) === "agent" || channel === "agent-chat") && /\bcodex\b/.test(from ?? "")))
    return "codex";
  if (channel === "agent-chat" || recordedVia === "claude code" || recordedVia?.startsWith("claude code ")) {
    return "claude code";
  }
  // the app's own drop zone: the `web` channel, named for what it is to the
  // person — something they dropped in (Nick, 2026-08-27) — not for the
  // transport. The stamp underneath stays "web".
  if (channel === "web" || recordedVia === "web") return "dropped";
  // a recorded name that IS a current family passes through — family names
  // stay stable even where the structured channel fields drifted
  if (recordedVia && (CONNECTOR_FAMILIES.has(recordedVia) || shippedIntegrations().has(recordedVia)))
    return recordedVia;
  // a pairing credential is named `<browser> on <machine>` (lib/pair.ts):
  // the note a person types in the extension's popup lands under THEIR
  // name, but the door it came through is the extension
  if (recordedVia && BROWSER_VIA.test(recordedVia)) return "browser extension";
  // a shipped integration's own channel is its family: granola, email, …
  if (channel && shippedIntegrations().has(channel)) return channel;
  if (from === "granola") return "granola";
  if (channel === "import") return "import";
  if (channel === "api" && from === "send-to-bigbrain") return "browser extension";
  if (channel === "api" && from === "bigbrain-feedback") return "bigbrain feedback";
  if (scalar(envelope.from_kind) === "agent") return from?.replace(/-/g, " ") || channel || "agents";
  return "other";
}

function tracksLabel(source: SourceMetadata): string | undefined {
  const envelope = source.envelope as Envelope;
  if (envelope.source !== "that-tracks") return undefined;
  const declared = scalar(envelope.tracker_name);
  if (declared) return declared;
  // Older arrivals already preserve the historical tracker name in their
  // generated title. Read it without rewriting or re-importing the source.
  const change = envelope.that_tracks as { entity?: string; operation?: string } | undefined;
  if (change?.entity !== "events" && change?.entity !== "trackers") return undefined;
  if (change.operation === "delete") return source.title.match(/^Withdrawn from That Tracks — (.+)$/u)?.[1];
  if (change.entity === "trackers") return source.title.match(/^That Tracks tracker: (.+)$/u)?.[1];
  return source.title.match(/^(.+) — \d{4}-\d{2}-\d{2}T\S+$/u)?.[1];
}

/** The filed-by facet of one insertion — the feed's rows and the assertion
 * graph's source nodes both read THIS, so one item wears one filer on every
 * surface (the viewer's filedByLabel maps the same fields either way).
 * (#497: the canonical-filer attestation override is gone with the
 * attestation layer — era-drifted envelopes wear their own spelling, which
 * the family collapse below absorbs.) */
export function insertionFiler(
  source: SourceMetadata,
  root?: string
): {
  band: RecentEntry["band"];
  from: string;
  via?: string;
  channel?: string;
  sourceDetail?: string;
  agentModel?: string;
} {
  const envelope = source.envelope as Envelope;
  const provenance = fmProvenance(envelope);
  const via = projectedFilerName(envelope);
  const sourceDetail = tracksLabel(source) ?? scalar(envelope.inbox);
  // A projected row carries its transcript's model, read once at projection;
  // anything else reads the transcript itself, and only when nothing else names one.
  const transcriptModel = (): string | undefined => {
    if (envelope.source !== "agent-chat" || via !== "claude code") return undefined;
    if ("transcriptModel" in source) return (source as SourceSummary).transcriptModel ?? undefined;
    return root ? savedClaudeModel(root, envelope.attachments) : undefined;
  };
  const model = [envelope.agent_model, envelope.model].map(scalar).find(value => value && value.toLowerCase() !== "n/a") ?? transcriptModel();
  return {
    band: provenance.band === "engine" ? authorBand(source.author) : provenance.band,
    from: provenance.from ?? source.author.id,
    via,
    channel: scalar(envelope.source),
    ...(sourceDetail ? { sourceDetail } : {}),
    ...(model ? { agentModel: model } : {}),
  };
}

/** An agent wrote it: its stamp names an agent (Pilot, an MCP client, an
 * agent token, a drop that says so), or it is an agent's conversation. The
 * viewer loads such a source's remote images only on a click — an image's
 * address is a request to wherever its writer chose. */
export function agentWritten(source: SourceMetadata): boolean {
  const envelope = source.envelope as Envelope;
  const provenance = fmProvenance(envelope);
  const kind = scalar(envelope.kind) ?? scalar(envelope.type), channel = scalar(envelope.source);
  return (provenance.band === "engine" ? authorBand(source.author) : provenance.band) === "agent"
    || ["agent-chat", "pilot-chat", "handoff-answer"].includes(kind ?? "")
    || ["agent-chat", "pilot", "codex", "claude-code"].includes(channel ?? "");
}

/** What the feed's TRIAGED/INGESTED column may claim about an insertion —
 * the same facts the work queue reads (lib/work.ts DUE_INTAKE_SQL), so the
 * check and the gardener's to-do list cannot disagree:
 *
 *   filed     an assertion cites it — its links are built
 *   declined  the gardener read it and passed (terminal, shown as done)
 *   record    never intake at all — an observation (the memory pass's
 *             signal), or a transcript too short to have an owner's side
 *             (lib/intakeClass.ts intakePriority) — is home the moment it
 *             lands, and nothing is coming to "finish" it
 *   pending   waiting for the gardener
 *
 * It used to be "record" for every row, unconditionally: a web clip wore
 * the check the instant it landed, over an empty neighbourhood
 * (2026-08-27). */
export function insertionStatus(
  priority: number | null,
  cited: boolean,
  declined: boolean
): FilingStatus {
  if (priority === null) return "record";
  if (cited) return "filed";
  if (declined) return "declined";
  return "pending";
}

/** The arrivals still WAITING for the gardener, by insertion id — the
 * verdict the feed's spinner reads (insertionStatus), so the graph's
 * spinning point (lib/assertionGraph.ts) and the row's mark cannot
 * disagree. Superseded landings are the caller's to drop, as the feed
 * does; a voice arrival is the graph's to leave out. */
export function pendingInsertionIds(root: string, events: readonly SourceSummary[], settlement: Pick<SourceRecord, "cited" | "declined"> = sourceRecord(root)): Set<string> {
  const { cited, declined } = settlement;
  const out = new Set<string>();
  for (const source of events)
    if (insertionStatus(source.intakePriority, cited.has(source.id), declined.has(source.id)) === "pending")
      out.add(source.id);
  return out;
}

export function recentFromSourceLog(root: string, events: readonly SourceSummary[] = [...sourceRecord(root).sources.values()], settlement = sourceRecord(root)): RecentEntry[] {
  const { cited, declined } = settlement;
  // A superseded landing (lib/sourceSupersede.ts) is not a row: its
  // successor is the same object, once.
  const superseded = supersededInsertionIds(events);
  return events.filter((source) => !superseded.has(source.id)).map((source) => {
    const { band, from, via, channel, sourceDetail, agentModel } = insertionFiler(source, root);
    const envelope = source.envelope as Envelope;
    const aboutRaw = envelope.about;
    const about = scalar(Array.isArray(aboutRaw) ? aboutRaw[0] : aboutRaw);
    const url = scalar(envelope.url);
    return {
      path: insertionEventRel(source),
      id: source.source_id,
      insertionId: source.id,
      ...(channel === "agent-chat" && scalar(envelope.key) ? { sessionId: scalar(envelope.key)! } : {}),
      title: source.title,
      author: "intake",
      action: "added",
      from,
      band,
      modified: timestamp(source),
      status: insertionStatus(source.intakePriority, cited.has(source.id), declined.has(source.id)),
      type: "source",
      // what this is ON (nestNotes, web/ui/src/lib/feed.ts): a note typed
      // beside a clip carries the clip's id in `about`; a clip carries its
      // page `url`. Without these on the row, the annotation and its
      // subject sat as two strangers a row apart (2026-08-27).
      ...(about ? { about } : {}),
      ...(url ? { url } : {}),
      ...(scalar(envelope.kind) === "annotation" ? { category: "annotation" } : {}),
      ...(via ? { via } : {}),
      ...(channel ? { source: channel } : {}),
      ...(sourceDetail ? { sourceDetail } : {}),
      ...(agentModel ? { agentModel } : {}),
      excerpt: source.excerpt,
    };
  }).sort((a, b) => b.modified - a.modified || b.path.localeCompare(a.path));
}

export interface RecentSourcePage {
  recent: RecentEntry[];
  nextOffset: number | null;
  total: number;
}

/** One stable page over the source projection. Offset pagination is enough
 * here: a live arrival invalidates the home view and resets it to page zero,
 * while scrolling only walks the immutable snapshot already on disk. */
export function recentSourcePage(root: string, offset: number, limit: number, source?: string): RecentSourcePage {
  return readFeedPage(root, offset, limit, source, record => recentRows(root, record));
}

function recentRows(root: string, record: SourceRecord): RecentEntry[] {
  const events = [...record.sources.values()];
  const rows = recentFromSourceLog(root, events, record);
  const threads = record.threadByInsertion;
  const byInsertion = new Map(rows.map(row => [row.insertionId, row]));
  const seen = new Set<string>();
  const all = rows.flatMap((row) => {
    const thread = row.insertionId ? threads.get(row.insertionId) : undefined;
    if (!thread) return [row];
    if (seen.has(thread.id)) return [];
    seen.add(thread.id);
    const states = new Set(thread.members.map(s => byInsertion.get(s.id)?.status));
    const status = states.has("pending") ? "pending" : states.has("filed") ? "filed"
      : states.has("record") ? "record" : row.status;
    return [{ ...row, path: thread.path, title: thread.title, threadCount: thread.members.length, status } as RecentEntry];
  });
  return all;
}

/** Does this path have the SHAPE of a source-insertion event, whether or not
 * one is there? The note door needs the difference: a path shaped like an
 * event but absent from the log is a 404 with a reason (retracted, moved),
 * not the read jail's 403 — which sent a reader hunting for a permission
 * problem it never had. */
export function isSourceInsertionPath(path: string): boolean {
  return sourcePath.test(path);
}

/** Exact-path read: no glob, traversal, or arbitrary access to log/. */
export function readSourceInsertionPath(root: string, path: string): SourceInsertion | undefined {
  const match = sourcePath.exec(path);
  if (!match) return undefined;
  try {
    const source = JSON.parse(readFileSync(join(root, path), "utf8")) as SourceInsertion;
    if (source.event !== "source.inserted" || source.id !== match[1] || !source.source_id)
      return undefined;
    return source;
  } catch {
    return undefined;
  }
}

/** Render the discussable lake item through the existing note reader.
 * `copies`: the same document's other landings (lib/sourceCopies.ts), named
 * under the front block so a reader holding a stub reaches the text. */
export function sourceInsertionMarkdown(source: SourceInsertion, copies: readonly { path: string; title: string }[] = []): string {
  const date = sourceMoment(source) || undefined;
  // Where it was captured (lib/sourceOrigin.ts): the viewer has always
  // offered it to open; a reader asked for "the link" needs it as much.
  const origin = sourceOrigin(source.envelope);
  return [
    "---",
    "type: source",
    `source_id: ${JSON.stringify(source.source_id)}`,
    `insertion_id: ${JSON.stringify(source.id)}`,
    ...(date ? [`date: ${JSON.stringify(date)}`] : []),
    `title: ${JSON.stringify(source.title)}`,
    ...(origin?.kind === "url" ? [`url: ${JSON.stringify(origin.url)}`] : []),
    "---",
    "",
    ...(copies.length ? [`_Also in the vault as: ${copies.map((copy) => `[[${copy.path}|${copy.title}]]`).join(" · ")}, the fullest first._`, ""] : []),
    source.body,
    "",
  ].join("\n");
}

// One in-flight feed preparation per vault; all page/filter requests share it.
// The worker publishes through the same revision-checked SQLite owner as graph
// warming. Only compact requested rows come back onto the viewer thread.
const feedBuilds = new Map<string, Promise<void>>();
export async function recentSourcePageAsync(root: string, offset: number, limit: number, source?: string): Promise<RecentSourcePage> {
  if (currentReadRevision(root)) return recentSourcePage(root, offset, limit, source);
  for (;;) {
    const page = preparedFeedPage(root, offset, limit, source);
    if (page) return page;
    let pending = feedBuilds.get(root);
    if (!pending) {
      pending = background<{ revision: string }>({ kind: "feed", root }).then(() => {})
        .finally(() => feedBuilds.delete(root));
      feedBuilds.set(root, pending);
    }
    await pending;
  }
}
