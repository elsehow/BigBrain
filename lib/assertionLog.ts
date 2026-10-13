/** Append-only assertions: what was said about the sources, by whom.
 *
 * One log, four kinds (docs/plans/2026-10-11-field-of-assertions.md):
 *  - prose: ontology-free natural language. Relationships live in prose,
 *    wikilinks identify entities, source references point to immutable
 *    insertions. An event with no `kind` is prose, as every assertion
 *    written before kinds is.
 *  - identity: which entities and sources are one thing.
 *  - decline: nothing in what it cites is worth asserting.
 *  - retraction: an assertion of any kind no longer stands.
 * Each is made by a person or a model, cites the sources it rests on, and
 * has its `created_at`. A source is settled once a live assertion of any
 * kind cites it. The logs these kinds replaced are converted by `bigbrain
 * migrate` (lib/migrate.ts) and read by nothing else.
 *
 * Authorship records who asserted the proposition. Host code constructs and
 * validates events; models never write this log directly. The
 * append/read/commit machinery is lib/eventLog.ts; what lives here is what
 * only an assertion knows.
 */

import { eventLog, type AppendResult } from "./eventLog";
import { sha256hex } from "./hash";
import { AST_ID, ENT_ID, ENTITY_LINK, LENS_ID, RETIRED_EVENT_ID, norm } from "./ids";
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
  /** The model that made it, when a model did and the producer knows which:
   * the gardener's writes name it (lib/vaultTools.ts submit). */
  model?: string;
}

/** What an assertion says. */
export type AssertionKind = "prose" | "identity" | "decline" | "retraction" | "inclusion";

/** What every kind carries. */
interface Asserted {
  event: "assertion.asserted";
  id: string;
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
  /** The event in a retired log this was converted from (`bigbrain migrate`,
   * lib/migrate.ts); its author, time and producer are this one's. */
  migrated_from?: string;
}

/** A prose assertion: the kind everything before kinds was, and the one the
 * entity view, the graph, search and the memory pass read. */
export interface AssertionEvent extends Asserted {
  kind?: "prose";
  text: string;
  entities: AssertionEntity[];
  /** Current format. The assertion is attributable to these immutable inputs;
   * the model is not required to reproduce source text. */
  sources?: AssertionSourceReference[];
  /** Legacy exact-quote evidence. Tolerant readers retain it, but new intake
   * never emits it. */
  citations?: AssertionCitation[];
  confidence: "direct" | "candidate";
  /** The assertion this one corrects and stands in place of (#629): same
   * claim, better resolved. The original is retracted with `superseded_by`
   * pointing here; both point at each other. */
  supersedes?: string;
}

/** Which entities and sources are one thing. `same`: the alias names the
 * entity (an alias declared, a fold accepted). `distinct`: the two entities
 * are not one (a fold refused). `copy`: the two cited sources are one work;
 * a model's judgment carries its score, and the cut-off is applied on read.
 * `not-copy`: a person says the two are not. `is-source`: the entity is the
 * one source cited. */
export type Identity =
  | { says: "same"; alias: AssertionEntity; entity: AssertionEntity }
  | { says: "distinct"; entities: [AssertionEntity, AssertionEntity] }
  | { says: "copy"; score?: number }
  | { says: "not-copy" }
  | { says: "is-source"; entity: AssertionEntity };

export interface IdentityAssertion extends Asserted {
  kind: "identity";
  identity: Identity;
  /** None for a fold made by hand; the pair for a copy; the one source an
   * entity is. */
  sources: AssertionSourceReference[];
}

/** Nothing in these sources is worth asserting, and why: they are settled
 * (§2, work is a view), and retracting the decline sends them back. */
export interface DeclineAssertion extends Asserted {
  kind: "decline";
  /** One line, durable. Free text is data, never instructions. */
  reason: string;
  sources: AssertionSourceReference[];
}

/** An assertion no longer stands: it is then as if never made. A correction
 * names the assertion that stands in its place. */
export interface RetractionAssertion extends Asserted {
  kind: "retraction";
  /** The assertion withdrawn: of any kind but a retraction. */
  retracts: string;
  superseded_by?: string;
  /** One line, durable. Free text is data, never instructions. */
  reason: string;
}

/** One source's place in one lens. A model's verdict is its `score` against
 * the lens's rule; a person's is `include`, and `how` they said it: a rating
 * (which teaches the evaluator too), a pin or an exclusion. */
export interface InclusionVerdict {
  insertion_id: string;
  source_id: string;
  /** What was judged: the note's text and the claims read with it
   * (lib/stages/inclusion.ts verdictInput). A person's verdict has none. */
  input?: string;
  score?: number;
  /** The note was too big to read whole and was judged on a summary of it. */
  summary?: true;
  include?: boolean;
  how?: "rating" | "pin" | "exclusion";
}

/** Sources in, or out of, a lens (docs/plans/2026-10-11-field-of-assertions.md,
 * "inclusion"). A scoring pass is one assertion per lens and pass, its
 * verdicts made under `rule`, the evaluator's identity: the rule's text, its
 * ratings, the entities it names and the model. A person's word is one per
 * source. Never published, and never settles intake. */
export interface InclusionAssertion extends Asserted {
  kind: "inclusion";
  lens: string;
  rule?: string;
  verdicts: InclusionVerdict[];
}

/** Any event in the assertion log. */
export type RecordedAssertion = AssertionEvent | IdentityAssertion | DeclineAssertion | RetractionAssertion | InclusionAssertion;

export const assertionKind = (event: RecordedAssertion): AssertionKind => event.kind ?? "prose";
export const isProse = (event: RecordedAssertion): event is AssertionEvent => assertionKind(event) === "prose";

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

/** The sources an assertion of any kind cites. */
export function citedSources(event: RecordedAssertion): AssertionSourceReference[] {
  if (isProse(event)) return assertionSourceReferences(event);
  if (event.kind === "inclusion") return event.verdicts.map(({ insertion_id, source_id }) => ({ insertion_id, source_id }));
  return event.kind === "retraction" ? [] : event.sources;
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
  if (!isProse(event)) throw new Error("assertion-log: not a prose assertion");
  if (event.text.length < 12 || event.text.length > 2_000 || /\n/u.test(event.text))
    throw new Error("assertion-log: assertion text must be one 12-2000 character line");
  if (!validEventAuthor(event.author)) throw new Error("assertion-log: invalid author");
  const refs = assertionSourceReferences(event);
  if (!refs.length) throw new Error("assertion-log: at least one source reference is required");
  if (event.sources?.length && event.citations?.length)
    throw new Error("assertion-log: an event cannot mix source references and legacy citations");
  if (!event.produced_by.procedure.trim() || !event.produced_by.version.trim())
    throw new Error("assertion-log: production procedure and version are required");
  if (event.produced_by.model !== undefined && (typeof event.produced_by.model !== "string" || !event.produced_by.model.trim()))
    throw new Error("assertion-log: a named model must be a non-empty string");
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

const clean = (value: string): string => value.trim().replace(/\s+/g, " ");
/** An assertion's id: what makes it this assertion, hashed. */
const assertionId = (identity: unknown): string => `ast_${sha256hex(JSON.stringify(identity)).slice(0, 24)}`;
const oneLine = (value: unknown): boolean =>
  typeof value === "string" && Boolean(value.trim()) && value.length <= 2_000 && !/\n/u.test(value);
const validEntity = (entity: AssertionEntity | undefined): boolean =>
  Boolean(entity && ENT_ID.test(entity.id ?? "") && entity.label?.trim() && entity.label === clean(entity.label));

function validateAsserted(event: Asserted): void {
  if (event.event !== "assertion.asserted" || !AST_ID.test(event.id))
    throw new Error("assertion-log: invalid event identity");
  if (!validEventAuthor(event.author)) throw new Error("assertion-log: invalid author");
  if (!event.created_at?.trim()) throw new Error("assertion-log: created_at is required");
  if (!event.produced_by?.procedure?.trim() || !event.produced_by.version?.trim())
    throw new Error("assertion-log: production procedure and version are required");
  if (event.migrated_from !== undefined && !RETIRED_EVENT_ID.test(event.migrated_from))
    throw new Error("assertion-log: migrated_from names an event in a retired log");
}

function validateRefs(refs: readonly AssertionSourceReference[] | undefined): void {
  if (!Array.isArray(refs)) throw new Error("assertion-log: sources must be a list");
  for (const ref of refs)
    if (!ref.insertion_id?.trim() || !ref.source_id?.trim())
      throw new Error("assertion-log: every source reference requires an insertion and source");
}

function validateIdentity(event: IdentityAssertion): void {
  const { identity, sources } = event;
  validateRefs(sources);
  const pair = (): void => {
    if (sources.length !== 2 || sources[0]!.insertion_id >= sources[1]!.insertion_id)
      throw new Error("assertion-log: a copy names two sources, ascending");
  };
  switch (identity?.says) {
    case "same":
      if (!validEntity(identity.alias) || !validEntity(identity.entity))
        throw new Error("assertion-log: invalid entity in identity");
      if (identity.alias.label.length > 200 || identity.alias.id !== assertionEntityId(identity.alias.label))
        throw new Error("assertion-log: an alias is a label of 1-200 characters and the id it hashes to");
      if (identity.alias.id === identity.entity.id) throw new Error("assertion-log: an alias names another entity");
      return;
    case "distinct": {
      const [a, b] = identity.entities ?? [];
      if (!validEntity(a) || !validEntity(b) || a!.id >= b!.id)
        throw new Error("assertion-log: distinct names two entities, ascending by id");
      return;
    }
    case "copy":
      pair();
      if (identity.score === undefined) {
        if (event.author.kind === "model") throw new Error("assertion-log: a model's copy judgment carries its score");
      } else if (event.author.kind !== "model" || typeof identity.score !== "number" || !(identity.score >= 0 && identity.score <= 1))
        throw new Error("assertion-log: a copy's score is a model's, from 0 to 1");
      return;
    case "not-copy":
      pair();
      if (event.author.kind === "model") throw new Error("assertion-log: a model judges copies by score");
      return;
    case "is-source":
      if (!validEntity(identity.entity) || sources.length !== 1)
        throw new Error("assertion-log: an entity is one source");
      return;
    default:
      throw new Error("assertion-log: unknown identity");
  }
}

/** Any kind, by its own rules. What the log validates on append and read. */
export function validateRecordedAssertion(event: RecordedAssertion): void {
  switch (event.kind ?? "prose") {
    case "prose":
      return validateAssertionEvent(event as AssertionEvent);
    case "identity":
      validateAsserted(event);
      return validateIdentity(event as IdentityAssertion);
    case "decline": {
      const decline = event as DeclineAssertion;
      validateAsserted(decline);
      if (!oneLine(decline.reason)) throw new Error("assertion-log: a decline's reason is one 1-2000 character line");
      validateRefs(decline.sources);
      if (!decline.sources.length) throw new Error("assertion-log: a decline cites at least one source");
      return;
    }
    case "retraction": {
      const retraction = event as RetractionAssertion;
      validateAsserted(retraction);
      if (!AST_ID.test(retraction.retracts ?? "")) throw new Error("assertion-log: invalid retracted id");
      if (retraction.superseded_by !== undefined &&
          (!AST_ID.test(retraction.superseded_by) || retraction.superseded_by === retraction.retracts))
        throw new Error("assertion-log: invalid superseding assertion id");
      if (!oneLine(retraction.reason)) throw new Error("assertion-log: a retraction's reason is one 1-2000 character line");
      if ("sources" in retraction) throw new Error("assertion-log: a retraction cites nothing");
      return;
    }
    case "inclusion": {
      const inclusion = event as InclusionAssertion;
      validateAsserted(inclusion);
      if (!LENS_ID.test(inclusion.lens ?? "")) throw new Error("assertion-log: invalid lens id");
      if (!Array.isArray(inclusion.verdicts) || !inclusion.verdicts.length) throw new Error("assertion-log: an inclusion has verdicts");
      validateRefs(inclusion.verdicts);
      for (const v of inclusion.verdicts) {
        const scored = v.score !== undefined, said = v.include !== undefined;
        if (scored === said) throw new Error("assertion-log: a verdict is a model's score or a person's word");
        if (scored && !(typeof v.score === "number" && v.score >= 0 && v.score <= 1 && typeof v.input === "string" && v.input))
          throw new Error("assertion-log: a score is 0-1, with what it judged");
        if (said && !(typeof v.include === "boolean" && (v.how === "rating" || v.how === "pin" || v.how === "exclusion")))
          throw new Error("assertion-log: a person's word says how");
      }
      if (inclusion.verdicts.some((v) => v.score !== undefined) && !inclusion.rule?.trim())
        throw new Error("assertion-log: scores name the rule they were made under");
      return;
    }
    default:
      throw new Error(`assertion-log: unknown kind ${String(event.kind)}`);
  }
}

const log = eventLog<RecordedAssertion>({
  name: "assertion",
  dir: ASSERTION_LOG_DIR,
  when: (event) => event.created_at,
  validate: validateRecordedAssertion,
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
  const event: AssertionEvent = {
    event: "assertion.asserted",
    id: assertionId({
      text: input.text, entities: input.entities, sources: sourcesResolved, citations, author: input.author,
      confidence: input.confidence, produced_by: input.produced_by,
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    }),
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

interface KindInput {
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
  migrated_from?: string;
}

/** `migrated_from` when there is one, for an event and the hash of its id. */
const migrated = (input: KindInput): { migrated_from?: string } =>
  (input.migrated_from ? { migrated_from: input.migrated_from } : {});

function resolveSources(ids: readonly string[], sources: ReadonlyMap<string, SourceInsertion>): AssertionSourceReference[] {
  return [...new Set(ids)].sort().map((insertion_id) => {
    const source = sources.get(insertion_id);
    if (!source) throw new Error(`assertion-log: unknown source insertion ${insertion_id}`);
    return { insertion_id, source_id: source.source_id };
  });
}


function cleanIdentity(identity: Identity): Identity {
  const entity = (e: AssertionEntity): AssertionEntity => ({ id: e.id, label: clean(e.label) });
  switch (identity.says) {
    case "same": return { says: "same", alias: entity(identity.alias), entity: entity(identity.entity) };
    case "distinct": {
      const [a, b] = identity.entities.map(entity).sort((x, y) => x.id.localeCompare(y.id));
      return { says: "distinct", entities: [a!, b!] };
    }
    case "is-source": return { says: "is-source", entity: entity(identity.entity) };
    default: return { ...identity };
  }
}

/** `same`: the label names the entity. */
export const sameAs = (label: string, entity: AssertionEntity): Identity =>
  ({ says: "same", alias: { id: assertionEntityId(label), label }, entity });

/** The identity hash includes `created_at`, as an alias event's did: the
 * same thing declared again after a retraction is a new fact in time. */
export function createIdentityAssertion(
  input: KindInput & { identity: Identity; sources?: string[] },
  sources: ReadonlyMap<string, SourceInsertion> = new Map()
): IdentityAssertion {
  const identity = cleanIdentity(input.identity), refs = resolveSources(input.sources ?? [], sources);
  const { author, created_at, produced_by } = input;
  const event: IdentityAssertion = {
    event: "assertion.asserted",
    id: assertionId({ kind: "identity", identity, sources: refs, author, created_at, produced_by, ...migrated(input) }),
    kind: "identity", identity, sources: refs, author, created_at, produced_by, ...migrated(input),
  };
  validateRecordedAssertion(event);
  return event;
}

/** The identity hash excludes `created_at`, so a retried submission
 * converges on one event instead of duplicating it. */
export function createDeclineAssertion(
  input: KindInput & { reason: string; sources: string[] },
  sources: ReadonlyMap<string, SourceInsertion>
): DeclineAssertion {
  const reason = clean(input.reason), refs = resolveSources(input.sources, sources);
  const { author, created_at, produced_by } = input;
  const event: DeclineAssertion = {
    event: "assertion.asserted",
    id: assertionId({ kind: "decline", reason, sources: refs, author, produced_by, ...migrated(input) }),
    kind: "decline", reason, sources: refs, author, created_at, produced_by, ...migrated(input),
  };
  validateRecordedAssertion(event);
  return event;
}

/** The identity hash includes `created_at`: the same word said again later
 * is a new fact in time. */
export function createInclusionAssertion(
  input: KindInput & { lens: string; rule?: string; verdicts: InclusionVerdict[] }
): InclusionAssertion {
  const { lens, author, created_at, produced_by } = input;
  const verdicts = input.verdicts.map((v) => ({ ...v }));
  const event: InclusionAssertion = {
    event: "assertion.asserted",
    id: assertionId({ kind: "inclusion", lens, rule: input.rule ?? null, verdicts, author, created_at, produced_by, ...migrated(input) }),
    kind: "inclusion", lens, ...(input.rule ? { rule: input.rule } : {}), verdicts, author, created_at, produced_by, ...migrated(input),
  };
  validateRecordedAssertion(event);
  return event;
}

/** The identity hash excludes `created_at`, so a retried correction
 * converges on one event. */
export function createRetraction(
  input: KindInput & { retracts: string; superseded_by?: string; reason: string }
): RetractionAssertion {
  const reason = clean(input.reason);
  const { retracts, superseded_by, author, created_at, produced_by } = input;
  const event: RetractionAssertion = {
    event: "assertion.asserted",
    id: assertionId({ kind: "retraction", retracts, superseded_by: superseded_by ?? null, reason, author, produced_by, ...migrated(input) }),
    kind: "retraction", retracts, ...(superseded_by ? { superseded_by } : {}), reason, author, created_at, produced_by, ...migrated(input),
  };
  validateRecordedAssertion(event);
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

/** Every assertion in the log, of every kind, retracted ones included. */
export const readRecordedAssertions = log.read;

/** The LIVE prose record: every prose assertion minus the retracted ones
 * (#629) — what the entity view, the graph, the memory pass and identity
 * read. A shared server's vault records its revocations in log/revocations/
 * until it accepts retractions, so those count too; a personal vault holds
 * none (lib/retiredLogs.ts). `includeRevoked` is for the projection's own
 * bookkeeping and audits, never for a reader answering "what does the
 * record say". */
export function readAssertionLog(
  root: string,
  opts: { strict?: boolean; includeRevoked?: boolean } = {}
): AssertionEvent[] {
  const recorded = log.read(root, opts), rows = recorded.filter(isProse);
  if (opts.includeRevoked || !rows.length) return rows;
  const withdrawn = new Set(revokedAssertions(root, { strict: opts.strict }).keys());
  for (const event of recorded) if (event.kind === "retraction") withdrawn.add(event.retracts);
  return withdrawn.size ? rows.filter((event) => !withdrawn.has(event.id)) : rows;
}
