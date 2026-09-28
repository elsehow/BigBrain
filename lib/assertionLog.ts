/** Append-only, ontology-free natural-language assertions.
 *
 * Relationships live in prose. Wikilinks identify entities, source references
 * point to immutable insertions, and authorship records who asserted the
 * proposition. Host code constructs and validates events; models never write
 * this log directly.
 *
 * The append/read/commit machinery is lib/eventLog.ts, shared with the other
 * four logs; what lives here is what only an assertion knows.
 */

import { eventLog, type AppendResult } from "./eventLog";
import { sha256hex } from "./hash";
import { AST_ID, ENT_ID, ENTITY_LINK, norm } from "./ids";
import { validEventAuthor, type EventAuthor, type SourceInsertion } from "./insertionLog";
import { revokedAssertions } from "./revocationLog";

export const ASSERTION_LOG_DIR = "log/assertions";

export interface AssertionEntity {
  id: string;
  label: string;
}

export interface AssertionQuote {
  quote: string;
  start: number;
  end: number;
}

export interface AssertionCitation {
  insertion_id: string;
  source_id: string;
  quotes: AssertionQuote[];
}

export interface AssertionSourceReference {
  insertion_id: string;
  source_id: string;
}

export interface AssertionProduction {
  procedure: string;
  version: string;
  invocation_id?: string;
  prompt_version?: string;
}

export interface AssertionEvent {
  event: "assertion.asserted";
  id: string;
  text: string;
  entities: AssertionEntity[];
  /** Current format. The assertion is attributable to these immutable inputs;
   * the model is not required to reproduce source text. */
  sources?: AssertionSourceReference[];
  /** Legacy exact-quote evidence. Tolerant readers retain it, but new intake
   * never emits it. */
  citations?: AssertionCitation[];
  author: EventAuthor;
  confidence: "direct" | "candidate";
  created_at: string;
  produced_by: AssertionProduction;
  /** The assertion this one corrects and stands in place of (#629): same
   * claim, better resolved. The original is revoked in log/revocations/
   * with `superseded_by` pointing here; both point at each other. */
  supersedes?: string;
}

export interface AssertionInput {
  text: string;
  entities: AssertionEntity[];
  sources?: string[];
  citations?: Array<{ insertion_id: string; quotes: string[] }>;
  author: EventAuthor;
  confidence: AssertionEvent["confidence"];
  created_at: string;
  produced_by: AssertionProduction;
  supersedes?: string;
}

export type AssertionAppendResult = AppendResult<AssertionEvent>;

export function assertionSourceReferences(event: AssertionEvent): AssertionSourceReference[] {
  if (event.sources?.length) return event.sources;
  return (event.citations ?? []).map(({ insertion_id, source_id }) => ({ insertion_id, source_id }));
}

/** The id a label names. `[[Evan]]` and `[[Evan Keller]]` are therefore two
 * entities by construction; log/entity-aliases/ is how the record says they
 * are one person (lib/entityAliasLog.ts). */
export function assertionEntityId(label: string): string {
  const canonical = norm(label);
  if (!canonical) throw new Error("assertion-log: entity label is required");
  return `ent_${sha256hex(canonical).slice(0, 20)}`;
}

function validateLinks(text: string, entities: readonly AssertionEntity[]): void {
  const declared = new Map<string, string>();
  for (const entity of entities) {
    if (!ENT_ID.test(entity.id) || !entity.label.trim())
      throw new Error("assertion-log: invalid entity declaration");
    const prior = declared.get(entity.id);
    if (prior && norm(prior) !== norm(entity.label))
      throw new Error(`assertion-log: conflicting labels for ${entity.id}`);
    declared.set(entity.id, entity.label.trim().replace(/\s+/g, " "));
  }
  const linked = new Set<string>();
  for (const match of text.matchAll(ENTITY_LINK)) {
    const target = match[1]!.trim();
    if (!declared.has(target)) throw new Error(`assertion-log: undeclared entity link ${target}`);
    linked.add(target);
  }
  for (const id of declared.keys())
    if (!linked.has(id)) throw new Error(`assertion-log: declared entity ${id} is not linked in text`);
}

export function validateAssertionEvent(event: AssertionEvent): void {
  if (event.event !== "assertion.asserted" || !AST_ID.test(event.id))
    throw new Error("assertion-log: invalid event identity");
  if (event.text.length < 12 || event.text.length > 2_000 || /\n/u.test(event.text))
    throw new Error("assertion-log: assertion text must be one 12-2000 character line");
  if (!validEventAuthor(event.author)) throw new Error("assertion-log: invalid author");
  const refs = assertionSourceReferences(event);
  if (!refs.length) throw new Error("assertion-log: at least one source reference is required");
  if (event.sources?.length && event.citations?.length)
    throw new Error("assertion-log: an event cannot mix source references and legacy citations");
  if (!event.produced_by.procedure.trim() || !event.produced_by.version.trim())
    throw new Error("assertion-log: production procedure and version are required");
  if (event.supersedes !== undefined &&
      (!AST_ID.test(event.supersedes) || event.supersedes === event.id))
    throw new Error("assertion-log: invalid superseded assertion id");
  validateLinks(event.text, event.entities);
  for (const ref of refs) {
    if (!ref.insertion_id.trim() || !ref.source_id.trim())
      throw new Error("assertion-log: every source reference requires an insertion and source");
  }
  for (const citation of event.citations ?? []) {
    if (!citation.insertion_id.trim() || !citation.source_id.trim() || !citation.quotes.length)
      throw new Error("assertion-log: every citation requires an insertion, source, and quote");
    for (const quote of citation.quotes) {
      if (!quote.quote || quote.start < 0 || quote.end !== quote.start + quote.quote.length)
        throw new Error("assertion-log: invalid quote coordinates");
    }
  }
}

const log = eventLog<AssertionEvent>({
  name: "assertion",
  dir: ASSERTION_LOG_DIR,
  when: (event) => event.created_at,
  validate: validateAssertionEvent,
});

export function validateAssertionEvidence(
  event: AssertionEvent,
  sources: ReadonlyMap<string, SourceInsertion>
): void {
  validateAssertionEvent(event);
  for (const ref of assertionSourceReferences(event)) {
    const source = sources.get(ref.insertion_id);
    if (!source || source.source_id !== ref.source_id)
      throw new Error(`assertion-log: unknown source insertion ${ref.insertion_id}`);
  }
  for (const citation of event.citations ?? []) {
    const source = sources.get(citation.insertion_id)!;
    for (const quote of citation.quotes)
      if (source.body.slice(quote.start, quote.end) !== quote.quote)
        throw new Error(`assertion-log: quote is not exact source text in ${citation.source_id}`);
  }
}

/** Construct an immutable event while resolving source insertion identities.
 * Legacy callers may still supply quotes; new intake supplies source ids only. */
export function createAssertionEvent(
  input: AssertionInput,
  sources: ReadonlyMap<string, SourceInsertion>
): AssertionEvent {
  if (Boolean(input.sources?.length) === Boolean(input.citations?.length))
    throw new Error("assertion-log: supply source references or legacy citations, but not both");
  const sourcesResolved: AssertionSourceReference[] | undefined = input.sources &&
    [...new Set(input.sources)].map((insertion_id) => {
    const source = sources.get(insertion_id);
    if (!source) throw new Error(`assertion-log: unknown source insertion ${insertion_id}`);
    return { insertion_id, source_id: source.source_id };
  });
  const citations: AssertionCitation[] | undefined = input.citations?.map((citation) => {
    const source = sources.get(citation.insertion_id);
    if (!source) throw new Error(`assertion-log: unknown cited insertion ${citation.insertion_id}`);
    return {
      insertion_id: citation.insertion_id,
      source_id: source.source_id,
      quotes: citation.quotes.map((quote) => {
        const start = source.body.indexOf(quote);
        if (start < 0) throw new Error(`assertion-log: quote is not exact source text in ${source.source_id}`);
        return { quote, start, end: start + quote.length };
      }),
    };
  });
  const identity = JSON.stringify({
    text: input.text, entities: input.entities, sources: sourcesResolved, citations, author: input.author,
    confidence: input.confidence, produced_by: input.produced_by,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  });
  const event: AssertionEvent = {
    event: "assertion.asserted",
    id: `ast_${sha256hex(identity).slice(0, 24)}`,
    text: input.text.trim().replace(/\s+/g, " "),
    entities: input.entities,
    ...(sourcesResolved ? { sources: sourcesResolved } : {}),
    ...(citations ? { citations } : {}),
    author: input.author,
    confidence: input.confidence,
    created_at: input.created_at,
    produced_by: input.produced_by,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  };
  validateAssertionEvidence(event, sources);
  return event;
}

export const assertionEventRel = log.rel;

export const appendAssertionEvent = log.append;

export const listAssertionEventFiles = log.listFiles;

export const commitAssertionEvents = log.commit;

/** Cheap native-vault probe: is there any assertion event at all? The
 * request path answers this yes/no from directory listings alone — parsing
 * the corpus to decide native-vs-legacy was most of a search's cost on a
 * large vault (#456). */
export function hasAssertionEvents(root: string): boolean {
  return log.listFiles(root).length > 0;
}

/** The LIVE record: every assertion event minus the revoked ones
 * (log/revocations/, #629) — what the entity view, the graph, the memory
 * pass and identity read. `includeRevoked` is for the projection's own
 * bookkeeping and audits, never for a reader answering "what does the
 * record say". */
export function readAssertionLog(
  root: string,
  opts: { strict?: boolean; includeRevoked?: boolean } = {}
): AssertionEvent[] {
  const rows = log.read(root, opts);
  // Reading the revocation log costs a second directory walk, so skip it
  // when there is nothing to filter.
  if (opts.includeRevoked || !rows.length) return rows;
  const revoked = revokedAssertions(root, { strict: opts.strict });
  return revoked.size ? rows.filter((event) => !revoked.has(event.id)) : rows;
}
