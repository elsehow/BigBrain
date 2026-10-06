/** Read-only virtual notes over entities projected from assertion prose. */
import { ENTITY_ID_LINK } from "./ids";
import { entityExists, threadReadModel, withVaultSnapshot, invalidateVaultReadModel, entityReadModel, sourceAssertionReadModel, projectedSource } from "./vaultReadModel";
import { assertionSourceReferences } from "./assertionLog";
import type { AssertionEvent } from "./assertionLog";
import { insertionEventRel } from "./insertionLog";
import type { EventAuthor, SourceInsertion } from "./insertionLog";
import { containsAllTerms, matchTerms, stripLinks } from "./noteMatch";
import { insertionFiler, isSourceInsertionPath } from "./sourceFeed";
import type { RecentEntry } from "./viewTypes";
import { isSourceThreadPath, type SourceThread } from "./sourceThreads";

const pathPattern = /^projection\/entities\/(ent_[a-f0-9]{20})\.md$/u;
export const assertionEntityPath = (id: string): string => `projection/entities/${id}.md`;

/** One grounding source, wearing the filed-by facet the feed's rows and the
 * graph's source nodes wear (lib/sourceFeed.ts's insertionFiler) — the
 * viewer's assertion rows name a source's filer beside its chip, and it must
 * be the same filer every other surface shows. `source` is the channel, the
 * same key RecentEntry and GraphNode use for it. */
export interface ProjectedEntitySource {
  insertion_id: string;
  source_id: string;
  title: string;
  path: string;
  band: RecentEntry["band"];
  from: string;
  via?: string;
  source?: string;
}

export interface ProjectedEntityAssertion {
  id: string;
  text: string;
  confidence: AssertionEvent["confidence"];
  created_at: string;
  author: EventAuthor;
  sources: ProjectedEntitySource[];
  /** A joined shared vault's claim (lib/sharedReadUnion.ts): which vault. Absent on your own. */
  vault?: { id: string; name: string };
}

export interface ProjectedEntityView {
  id: string;
  label: string;
  assertions: ProjectedEntityAssertion[];
  /** Set when the server truncated `assertions` (web/server.ts's
   * `assertions=N` param): how many the record actually holds. Absent on a
   * full view. */
  total?: number;
  /** This entity IS the vault's own user (#501) — decided by the identity
   * record (declareUserIdentity's latest declaration), never by legacy
   * dossier frontmatter, which projected pages don't carry. */
  you?: true;
  /** Labels the alias log folds into this entity (lib/entityAliasLog.ts);
   * absent when none. */
  aliases?: string[];
}

/** All readers share the complete projection revision, independently of graph construction. */
export const invalidateAssertionRecord = invalidateVaultReadModel;

/** Does this path have the SHAPE of a projected dossier, whether or not the
 * record holds one? Same job as sourceFeed's isSourceInsertionPath: it lets
 * the note door answer "no such entity" instead of "forbidden path". */
export const isAssertionEntityPath = (path: string): boolean => pathPattern.test(path);

/** Does the record hold this dossier at all? The link resolver's cheap
 * existence check uses the index without decoding assertions or sources.
 * A resolver asks this of every path-shaped link in
 * a body. */
export function assertionEntityExists(root: string, path: string): boolean {
  const id = pathPattern.exec(path)?.[1];
  if (!id) return false;
  return entityExists(root, id);
}

/** Structured companion to the Markdown compatibility view. The browser uses
 * this shape so assertions cannot masquerade as an authored entity dossier. */
export function assertionEntityView(root: string, path: string): ProjectedEntityView | undefined {
  const asked = pathPattern.exec(path)?.[1];
  if (!asked) return undefined;
  const { rows, sources, aliases, id, owner: me } = entityReadModel(root, asked);
  // Every id in the record resolves through the alias log: a stub's path
  // lands on its canonical dossier, links in the prose point there too, and
  // the rows are everything that names the entity under any of its labels.
  const resolve = (entityId: string): string => aliases.canonical.get(entityId)?.id ?? entityId;
  if (!rows.length) return undefined;
  const label = rows.flatMap((row) => row.entities).find((e) => e.id === id)?.label
    ?? [...aliases.canonical.values()].find((e) => e.id === id)?.label
    ?? rows.flatMap((row) => row.entities).find((e) => resolve(e.id) === id)!.label;
  const linkedText = (text: string): string => text.replace(
    ENTITY_ID_LINK,
    (_all, entityId: string, display: string) => resolve(entityId) === id
      ? display
      : `[[${assertionEntityPath(resolve(entityId))}|${display}]]`,
  );
  const aliasLabels = aliases.labels.get(id) ?? [];
  return {
    id,
    label,
    ...(me && resolve(me.entity_id) === id ? { you: true as const } : {}),
    ...(aliasLabels.length ? { aliases: aliasLabels } : {}),
    assertions: rows.map((row) => ({
      id: row.id,
      text: linkedText(row.text),
      confidence: row.confidence,
      created_at: row.created_at,
      author: row.author,
      sources: assertionSourceReferences(row).flatMap((ref) => {
        const source = sources.get(ref.insertion_id);
        if (!source) return [];
        const filer = insertionFiler(source);
        return [{
          insertion_id: ref.insertion_id,
          source_id: ref.source_id,
          title: source.title,
          path: insertionEventRel(source),
          band: filer.band,
          from: filer.from,
          ...(filer.via ? { via: filer.via } : {}),
          ...(filer.channel ? { source: filer.channel } : {}),
        }];
      }),
    })),
  };
}

// ── the source note's rail ──────────────────────────────────────────────────
// A source used to open as its body alone: what intake made of it was
// visible only as edges in the neighbourhood, and never as a list (Nick,
// 2026-09-02). This is the entity view mirrored — the same memoized record,
// filtered by CITATION instead of by entity — and it leads the note the way
// the entity view's rail does: what the vault made of this, then what came
// in. A source is thousands of words; its assertions are a handful of lines,
// and below the body they would be as invisible as they were.

/** One entity an assertion links, as the source note's row wears it: the
 * chip and the dossier it opens. Resolved through the alias log, so a stub's
 * label lands on its canonical page — the path the entity view links. */
export interface ProjectedSourceEntity {
  id: string;
  label: string;
  path: string;
}

/** ProjectedEntityAssertion's twin. The meta names the ENTITIES, not the
 * sources: on a source note the grounding source is the page itself, and
 * its filer is the same for every row. */
export interface ProjectedSourceAssertion {
  sources?: Array<{ path: string; title: string }>;
  id: string;
  text: string;
  confidence: AssertionEvent["confidence"];
  created_at: string;
  author: EventAuthor;
  entities: ProjectedSourceEntity[];
}

/** The assertions grounded in ONE source insertion, in log order (the
 * client's newest-first is the same reversal the entity view does). Every
 * entity link in the prose is rewritten to its dossier path. Empty on a
 * source nothing cites — an answer the note shows, not a 404: "no
 * assertions yet" is how a declined or not-yet-reached source reads, and
 * seeing that is the point of the rail. Voice never grounds an assertion
 * (#641: it settles beside `sources`), so a directive's insertion answers
 * empty too. */
export function assertionsFromSource(root: string, insertionId: string | readonly string[]): ProjectedSourceAssertion[] {
  const ids = new Set(typeof insertionId === "string" ? [insertionId] : insertionId);
  return sourceAssertions(sourceAssertionReadModel(root, [...ids]));
}
function sourceAssertions({ rows, aliases }: ReturnType<typeof sourceAssertionReadModel>): ProjectedSourceAssertion[] {
  const resolve = (entityId: string): string => aliases.canonical.get(entityId)?.id ?? entityId;
  const linked = (text: string): string => text.replace(
    ENTITY_ID_LINK,
    (_all, entityId: string, display: string) => `[[${assertionEntityPath(resolve(entityId))}|${display}]]`,
  );
  return rows
    .map((row) => {
      // one chip per canonical entity, under the canonical label: a row
      // naming a stub and its canonical wears the dossier once
      const entities = new Map<string, ProjectedSourceEntity>();
      for (const e of row.entities) {
        const id = resolve(e.id);
        if (!entities.has(id))
          entities.set(id, { id, label: aliases.canonical.get(e.id)?.label ?? e.label, path: assertionEntityPath(id) });
      }
      return {
        id: row.id,
        text: linked(row.text),
        confidence: row.confidence,
        created_at: row.created_at,
        author: row.author,
        entities: [...entities.values()],
      };
    });
}

/** Reuse the validated graph/note snapshot instead of parsing a source body per hit. */
export function sourceInsertionCached(root: string, path: string): SourceInsertion | undefined {
  if (!isSourceInsertionPath(path)) return undefined;
  const id = path.slice(path.lastIndexOf("/") + 1, -5);
  const source = projectedSource(root, id);
  return source && insertionEventRel(source) === path ? source : undefined;
}

export function sourceThreadForInsertion(root: string, id: string): SourceThread | undefined {
  return threadReadModel(root, id, true);
}

export function sourceThreadView(root: string, path: string): (SourceThread & { assertions: ProjectedSourceAssertion[] }) | undefined {
  if (!isSourceThreadPath(path)) return undefined;
  return withVaultSnapshot(root, () => {
    const thread = threadReadModel(root, path);
    if (!thread) return undefined;
    const model = sourceAssertionReadModel(root, thread.members.map(s => s.id));
    const { rows, sources } = model;
    const originals = new Map(rows.map(a => [a.id, a]));
    return { ...thread, assertions: sourceAssertions(model).map(a => ({ ...a,
      sources: assertionSourceReferences(originals.get(a.id)!).flatMap(ref => {
        const source = sources.get(ref.insertion_id);
        return source ? [{ path: insertionEventRel(source), title: source.title }] : [];
      }),
    })) };
  });
}

/** A stable referent for DISCUSS/read_note, with every claim's original
 * citation preserved and all message paths available to the reader. */
export function sourceThreadMarkdown(thread: SourceThread & { assertions: ProjectedSourceAssertion[] }): string {
  return [`# ${thread.title}`, "", `${thread.members.length} messages`, "", "## Assertions", "",
    ...thread.assertions.map(a => `- ${a.text} (${a.created_at}) ${(a.sources ?? []).map(s => `[[${s.path}|${s.title}]]`).join(" ")}`),
    "", "## Messages", "", ...thread.members.map(s =>
      `- [[${insertionEventRel(s)}|${s.title}]] — ${s.occurred_at ?? s.received_at ?? ""}`), ""].join("\n");
}

/** The viewer's progressive window: the LATEST n assertions plus the true
 * total, so a dossier-scale entity's first paint ships kilobytes, not the
 * megabyte the full record is. Display order (newest-first) stays the
 * client's job — this keeps the log's ascending order. */
export function truncatedEntityView(view: ProjectedEntityView, n: number): ProjectedEntityView {
  return { ...view, total: view.assertions.length, assertions: view.assertions.slice(-n) };
}

/** The reader doors' window over a dossier (`/v1/note` and `read_note`):
 * which assertions, and in what order. A 165-assertion entity is 75KB of
 * log-ascending prose whose newest evidence sits at the end — an agent
 * asking "what does the record say about X since last week" wants the
 * matching rows, newest first, not the whole file to grep. */
export interface EntityViewFilter {
  /** Every term must appear in the assertion text (links reduced to their
   * labels), case-insensitive — the same all-terms posture as search. */
  q?: string;
  /** Inclusive YYYY-MM-DD bounds on the assertion's `created_at` day. */
  after?: string;
  before?: string;
  /** Keep the NEWEST n of what survived the filters — the viewer's window
   * semantics (truncatedEntityView), whatever the display order. */
  n?: number;
  /** Display order; the log's ascending order is the default. */
  order?: "asc" | "desc";
  /** Answer with the TABLE OF CONTENTS instead of the assertions
   * (projectedEntityToc) — what a reader wants when the dossier is too big
   * to serve whole and head-and-tail would decide by accident which
   * assertions it sees. */
  toc?: boolean;
}

/** Apply an EntityViewFilter. `total` is what the record holds; a view whose
 * `assertions` is the whole record carries no `total`, like the untruncated
 * view has always been shaped. */
export function filterEntityView(view: ProjectedEntityView, f: EntityViewFilter): ProjectedEntityView {
  // ONE all-terms vocabulary for every window over the record
  // (lib/noteMatch.ts) — an assertion filter and a source's block window
  // must agree on what "matches" means, or the same q= means two things
  // depending on which note the reader opened.
  const terms = matchTerms(f.q ?? "");
  let rows = view.assertions.filter((row) => {
    const day = row.created_at.slice(0, 10);
    if (f.after && day < f.after) return false;
    if (f.before && day > f.before) return false;
    if (!terms.length) return true;
    return containsAllTerms(row.text, terms);
  });
  if (f.n !== undefined && f.n >= 1 && rows.length > f.n) rows = rows.slice(-f.n);
  if (f.order === "desc") rows = [...rows].reverse();
  const total = view.total ?? view.assertions.length;
  return { ...view, assertions: rows, ...(rows.length < total ? { total } : {}) };
}

export function projectedEntityMarkdown(view: ProjectedEntityView, caption?: string): string {
  const body = view.assertions.flatMap((row) => {
    const refs = row.sources.map((source) => `[[${source.path}|${source.title}]]`);
    return [`- ${row.text}`, ...(refs.length ? [`  Sources: ${refs.join(" · ")}`] : []), ""];
  });
  return [
    "---", "type: entity", `title: ${JSON.stringify(view.label)}`, `entity_id: ${view.id}`,
    ...(view.aliases?.length ? [`aliases: [${view.aliases.map((a) => JSON.stringify(a)).join(", ")}]`] : []),
    "---", "",
    `# ${view.label}`, "", ...(caption ? [`_${caption}_`, ""] : []), ...body,
  ].join("\n");
}

// ── the dossier's table of contents ─────────────────────────────────────────
// A busy entity is 165 assertions and 75KB. Whoever serves it has to elide,
// and eliding a log-ascending list to head-and-tail makes WHICH assertions
// the reader sees a function of where they happen to sit in the file. A
// table of contents elides on purpose: every assertion is accounted for by
// its date bucket, each bucket carries a handle (`after=`/`before=`) that
// fetches exactly that region, and the samples are enough to tell whether
// the bucket is the one you want.
//
// Mechanical on purpose (#618's discipline): buckets are calendar months, or
// days when the whole dossier fits inside one month. No topic grouping — that
// would be a model call, and the engine sorts but never answers.

const SAMPLES_PER_BUCKET = 3;
const SAMPLE_CHARS = 110;

const sample = (text: string): string => {
  const flat = stripLinks(text).replace(/\s+/gu, " ").trim();
  return flat.length > SAMPLE_CHARS ? `${flat.slice(0, SAMPLE_CHARS - 1)}…` : flat;
};

/** first, middle and last of a bucket — the cheapest deterministic three
 * that say what a bucket is about without ordering by anything but time. */
const spread = <T>(rows: T[], n: number): T[] => {
  if (rows.length <= n) return rows;
  const picked = new Set<number>();
  for (let i = 0; i < n; i++) picked.add(Math.round((i * (rows.length - 1)) / (n - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => rows[i]!);
};

/**
 * The dossier as a table of contents: date-bucketed counts, each bucket's
 * exact day span as the window that fetches it, and a few assertions per
 * bucket to orient. `total` is what the record holds when `view` is already
 * windowed — the caption has to say what the TOC is a table of.
 */
export function projectedEntityToc(view: ProjectedEntityView): string {
  const rows = [...view.assertions].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const total = view.total ?? view.assertions.length;
  const head = [
    "---", "type: entity", `title: ${JSON.stringify(view.label)}`, `entity_id: ${view.id}`, "---", "",
    `# ${view.label}`, "",
  ];
  if (!rows.length)
    return [...head, `_Table of contents: no assertions${total ? ` of ${total} match this window` : ""}._`, ""]
      .join("\n");

  const days = rows.map((row) => row.created_at.slice(0, 10));
  const months = new Set(days.map((day) => day.slice(0, 7)));
  const width = months.size > 1 ? 7 : 10; // month buckets, or days inside one month
  const buckets = new Map<string, ProjectedEntityAssertion[]>();
  for (const row of rows) {
    const key = row.created_at.slice(0, width);
    const held = buckets.get(key);
    if (held) held.push(row);
    else buckets.set(key, [row]);
  }

  const caption =
    `_Table of contents: ${rows.length}${rows.length < total ? ` of ${total}` : ""} assertions, ` +
    `${days[0]} → ${days.at(-1)}. Newest bucket first. Fetch one with the after=/before= beside it, ` +
    `narrow with q=<terms>, or take the newest few with n=20 order=desc._`;

  const body = [...buckets.entries()].reverse().flatMap(([key, group]) => {
    const from = group[0]!.created_at.slice(0, 10);
    const to = group.at(-1)!.created_at.slice(0, 10);
    return [
      `## ${key} — ${group.length} assertion${group.length === 1 ? "" : "s"}` +
        (from === to ? ` (${from})` : ` (${from} → ${to})`),
      `\`after=${from} before=${to}\``,
      "",
      ...spread(group, SAMPLES_PER_BUCKET).map((row) => `- ${sample(row.text)}`),
      "",
    ];
  });
  return [...head, caption, "", ...body].join("\n");
}

export function assertionEntityMarkdown(root: string, path: string): string | undefined {
  const view = assertionEntityView(root, path);
  return view ? projectedEntityMarkdown(view) : undefined;
}
