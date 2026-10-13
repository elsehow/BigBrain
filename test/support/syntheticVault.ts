/** syntheticVault.ts — a large vault of invented content, the same for the
 * same seed, byte for byte. What a refactor is proven on from a machine
 * with no real vault: `bun run field:digest` before and after.
 *
 *   bun test/support/syntheticVault.ts <empty dir> [--sources 2000] [--seed 1]
 *
 * Every name, address and sentence is generated from the word lists below
 * (docs/development-data.md); none is drawn from a vault. It writes through
 * the engine's own create and append functions, so it holds only what the
 * engine would accept, and the shapes a refactor can get wrong are all here:
 *
 * - mail in threads (subjects re-sent, `Re:`-prefixed, across one inbox),
 *   notes, meetings, and web clips, some at one address (copies);
 * - re-landings that supersede an earlier insertion of the same source;
 * - prose by the gardener (with its runs' journals naming the model), by an
 *   agent and by the owner, citing one source or two;
 * - retractions, and rewrites that supersede what they replace;
 * - declines, some retracted, and arrivals nothing has reached yet;
 * - aliases (some chained, some retracted), entities kept distinct,
 *   entity–source bindings, a model's copy scores and the owner's verdicts;
 * - a feed journal, and memory topics citing assertions and linking entities;
 * - one git commit of all of it, at a fixed time, as the engine would have made.
 *
 * The logs the engine no longer reads (lib/retiredLogs.ts) are not written:
 * a vault holding one is refused until `bigbrain migrate` converts it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendAssertionEvent, assertionEntityId, createAssertionEvent, createDeclineAssertion, createIdentityAssertion,
  createRetraction, sameAs, type AssertionEntity, type AssertionEvent, type AssertionProduction, type RecordedAssertion,
} from "../../lib/assertionLog";
import { syncAssertionProjection } from "../../lib/assertionProjection";
import type { FeedRecord } from "../../lib/feedJournal";
import { appendSourceInsertionEvent, sourceInsertion, type EventAuthor, type SourceInsertion } from "../../lib/insertionLog";

export interface SyntheticVaultOpts {
  /** How many arrivals; everything else scales from it. */
  sources?: number;
  seed?: number;
}

export interface SyntheticVaultCounts {
  sources: number;
  assertions: number;
  entities: number;
  memory: number;
  journals: number;
}

const FIRST = ["Ada", "Basil", "Clio", "Dorian", "Edda", "Fenn", "Greer", "Hollis", "Ines", "Jory", "Kestrel", "Linnea",
  "Marlo", "Nell", "Oren", "Pell", "Quill", "Rowan", "Sable", "Tamsin", "Ulla", "Vesper", "Wren", "Yarrow", "Zeno"];
const LAST = ["Ashgrove", "Brightwater", "Calloway", "Dunmore", "Elderfield", "Fairweather", "Greystone", "Hartwell",
  "Ironside", "Juniper", "Kettering", "Larkspur", "Merriweather", "Northcott", "Oakhaven", "Pemberly", "Quarrington",
  "Ravensworth", "Stillwater", "Thistledown", "Underhill", "Vantongeren", "Whitlock", "Yardley"];
const THINGS = ["Orrery", "Kiln", "Lantern Project", "Seed Library", "Tide Table", "Glasshouse", "Ferry Schedule",
  "Loom", "Bell Foundry", "Map Room", "Apiary", "Weather Station", "Paper Mill", "Night School", "Signal Tower",
  "Cider Press", "Observatory", "Print Shop", "Orchard", "Archive"];
const PLACES = ["Harrowgate", "Millbrook", "Saltmarsh", "Cobble Hill", "Fernwick", "Lower Dene", "Pike Harbour", "Wexcombe"];
const VERBS = ["met with", "wrote to", "asked about", "planned the", "reviewed the", "postponed the", "funded the",
  "visited", "sketched the", "repaired the", "argued over the", "finished the", "proposed the"];
const TOPICS = ["budget", "timeline", "spring visit", "draft", "inventory", "survey", "lease", "workshop", "catalogue", "rota"];
const HOSTS = ["example.org", "example.net", "papers.example.com", "notes.example.invalid"];
const MODELS = ["model-a", "model-b", "model-c"];

/** mulberry32: small, fast, and the same everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticVault(root: string, opts: SyntheticVaultOpts = {}): SyntheticVaultCounts {
  const total = Math.max(20, Math.trunc(opts.sources ?? 2000));
  const random = rng(opts.seed ?? 1);
  const chance = (p: number) => random() < p;
  const int = (n: number) => Math.floor(random() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  // Popular entities come up far more often than the tail, as in a real vault.
  const skewed = <T>(xs: readonly T[]): T => xs[Math.floor(xs.length * random() ** 2.2)]!;
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 5, 8) + minutes * 60_000).toISOString();

  mkdirSync(root, { recursive: true });
  if (readdirSync(root).length) throw new Error(`syntheticVault: ${root} is not empty`);
  writeFileSync(join(root, "vault.yaml"), `# A synthetic vault (test/support/syntheticVault.ts): every word in it is invented.\n${
    readFileSync(join(import.meta.dir, "..", "..", "vault.example.yaml"), "utf8")}\n# The feed journal below is read.\nfeed:\n  since: 2026-01-01\n`);
  writeFileSync(join(root, ".gitignore"), readFileSync(join(import.meta.dir, "..", "..", "deploy", "vault-template", "gitignore"), "utf8"));

  const people: AssertionEntity[] = [];
  for (const first of FIRST) for (const last of LAST)
    if (people.length < Math.max(30, total / 6) && chance(0.6)) people.push(entity(`${first} ${last}`));
  const things = [...THINGS, ...PLACES].map(entity);
  const entities = [...people, ...things];
  const subjects = Array.from({ length: Math.max(8, Math.trunc(total / 10)) }, () =>
    `${pick(TOPICS)} for the ${pick(THINGS).toLowerCase()} at ${pick(PLACES)}, ${pick(["first", "second", "final", "revised"])} round`);
  const urls: string[] = [];

  const sources: SourceInsertion[] = [];
  const byId = new Map<string, SourceInsertion>();
  const write = (events: RecordedAssertion[], event: RecordedAssertion) => { appendAssertionEvent(root, event); events.push(event); };
  const assertions: RecordedAssertion[] = [];
  const prose: AssertionEvent[] = [];
  const gardener = (run: number): EventAuthor => ({ kind: "model", id: "pi", invocation_id: `run-${run}` });
  const owner: EventAuthor = { kind: "user", id: "owner" };
  const agent: EventAuthor = { kind: "agent", id: "tidy-up" };
  const by = (procedure: string): AssertionProduction => ({ procedure, version: "v1" });
  const runs: { id: number; start: string; end: string; until: number; model: string }[] = [];

  // Arrivals, minutes apart, each with what was said about it.
  let clock = 0;
  for (let i = 0; i < total; i++) {
    clock += 1 + int(90);
    const received = at(clock);
    const named = Array.from({ length: 1 + int(3) }, () => skewed(entities));
    const sentence = `${named[0]!.label} ${pick(VERBS)} ${pick(TOPICS)} with ${(named[1] ?? pick(entities)).label}.`;
    const roll = random();
    let envelope: Record<string, unknown> & { id: string };
    if (roll < 0.4) {
      const subject = pick(subjects);
      envelope = { id: `mail-${i}`, source: "email", kind: "email", inbox: "owner@example.invalid",
        from: `${named[0]!.label.split(" ")[0]!.toLowerCase()}@example.invalid`, title: `${chance(0.5) ? "Re: " : ""}${subject}` };
    } else if (roll < 0.62) {
      envelope = { id: `note-${i}`, kind: "note", title: `Note on the ${pick(TOPICS)} (${i})` };
    } else if (roll < 0.72) {
      envelope = { id: `meeting-${i}`, kind: "meeting", title: `${pick(THINGS)} meeting, ${received.slice(0, 10)}` };
    } else if (roll < 0.95) {
      // Some clips land at an address already held, some with tracking on it: copies.
      const again = urls.length && chance(0.12) ? pick(urls) : undefined;
      const url = again ? `${again}${chance(0.5) ? "?utm_source=synthetic" : ""}` : `https://${pick(HOSTS)}/${pick(TOPICS)}/${i}`;
      if (!again) urls.push(url);
      envelope = { id: `clip-${i}`, kind: "web", url, title: `${pick(THINGS)}: ${pick(TOPICS)} (${i})` };
    } else {
      // A re-landing: the same source again, superseding what it replaces.
      const earlier = sources.filter((s) => !s.envelope["supersedes"]).at(-1 - int(Math.min(40, sources.length)));
      if (!earlier) { i--; continue; }
      envelope = { ...(earlier.envelope as { id: string }), supersedes: earlier.id, title: `${earlier.title} (revised)` };
    }
    const source = sourceInsertion({ ...envelope, received, date: received.slice(0, 10) }, `${sentence}\n\n${pick(VERBS)} ${pick(TOPICS)}.\n`);
    if (byId.has(source.id)) continue;
    appendSourceInsertionEvent(root, source, { wake: false });
    sources.push(source); byId.set(source.id, source);

    // What became of it: pending, declined, or asserted about.
    const fate = random();
    if (fate < 0.07) continue;
    if (fate < 0.15) {
      const decline = createDeclineAssertion({ sources: [source.id], reason: `nothing to file in ${source.source_id}`,
        author: gardener(i), created_at: at(clock + 5), produced_by: by("intake-assertion-agent") }, byId);
      write(assertions, decline);
      if (chance(0.25)) write(assertions, createRetraction({ retracts: decline.id, reason: "worth a second look",
        author: owner, created_at: at(clock + 30), produced_by: by("review") }));
      continue;
    }
    // The gardener works in runs of a few hours, each with its own model.
    if (!runs.length || clock > runs.at(-1)!.until)
      runs.push({ id: runs.length, start: at(clock + 1), end: at(clock + 240), until: clock + 240, model: MODELS[runs.length % MODELS.length]! });
    const run = runs.at(-1)!;
    for (let k = 0, n = 1 + int(4); k < n; k++) {
      const about = [...new Map(Array.from({ length: 1 + int(3) }, () => skewed(entities)).map((e) => [e.id, e])).values()];
      const cites = chance(0.15) && sources.length > 1 ? [source.id, sources[int(sources.length - 1)]!.id] : [source.id];
      const who = random();
      const [author, procedure] = who < 0.8 ? [gardener(run.id), "bigbrain-mcp"] : who < 0.9 ? [agent, "review"] : [owner, "note"];
      const event = createAssertionEvent({
        text: `${about.map((e) => `[[${e.id}|${e.label}]]`).join(" and ")} ${pick(VERBS)} ${pick(TOPICS)} (${i}.${k}).`,
        entities: about, sources: [...new Set(cites)], author, confidence: chance(0.8) ? "direct" : "candidate",
        created_at: at(clock + 2 + k), produced_by: by(procedure),
      }, byId);
      write(assertions, event); prose.push(event);
    }
  }

  // Corrections: withdrawn claims, and rewrites standing in for what they replace.
  for (const event of prose.filter(() => chance(0.1))) {
    const later = at(clock + 1 + int(600));
    if (chance(0.4)) {
      write(assertions, createRetraction({ retracts: event.id, reason: "not what the source says", author: owner, created_at: later, produced_by: by("review") }));
      continue;
    }
    const rewrite = createAssertionEvent({ text: `${event.text.replace(/\.$/, "")}, as corrected.`, entities: event.entities,
      sources: event.sources?.map((s) => s.insertion_id), author: agent, confidence: event.confidence, created_at: later,
      produced_by: by("entity-supersede"), supersedes: event.id }, byId);
    write(assertions, rewrite); prose.push(rewrite);
    write(assertions, createRetraction({ retracts: event.id, superseded_by: rewrite.id, reason: "rewritten", author: agent,
      created_at: later, produced_by: by("entity-supersede") }));
  }

  // Identity: other names, chained and withdrawn; two kept apart; sources that are entities; copies judged.
  clock += 1000;
  const said = (author: EventAuthor = owner) => ({ author, created_at: at(clock += 3), produced_by: by("fold") });
  for (const person of people.filter(() => chance(0.15))) {
    const [first, last] = person.label.split(" ") as [string, string];
    const short = createIdentityAssertion({ identity: sameAs(first, person), ...said() });
    write(assertions, short);
    if (chance(0.3)) write(assertions, createIdentityAssertion({ identity: sameAs(`${first[0]}. ${last}`, { id: assertionEntityId(first), label: first }), ...said() }));
    if (chance(0.15)) write(assertions, createRetraction({ retracts: short.id, reason: "a different person", ...said() }));
  }
  for (let k = 0; k < Math.max(2, total / 500); k++) {
    const [a, b] = [pick(people), pick(people)];
    if (a.id !== b.id) write(assertions, createIdentityAssertion({ identity: { says: "distinct", entities: [a, b] }, ...said() }));
  }
  const clips = sources.filter((s) => s.envelope["kind"] === "web");
  for (const clip of clips.filter(() => chance(0.04)))
    write(assertions, createIdentityAssertion({ identity: { says: "is-source", entity: pick(things) }, sources: [clip.id], ...said() }, byId));
  for (let k = 0; k < Math.max(2, total / 200) && clips.length > 1; k++) {
    const [a, b] = [pick(clips), pick(clips)];
    if (a.id === b.id) continue;
    const judged = chance(0.7) ? { says: "copy" as const, score: Math.round(random() * 100) / 100 } : { says: chance(0.5) ? "copy" as const : "not-copy" as const };
    const author: EventAuthor = "score" in judged ? { kind: "model", id: "judge", invocation_id: `copies-${k}` } : owner;
    write(assertions, createIdentityAssertion({ identity: judged, sources: [a.id, b.id].sort(), ...said(author) }, byId));
  }

  // The gardener's runs, each naming its model; the feed's calls.
  const journal = (dir: string, id: string, start: string, record: object) => {
    mkdirSync(join(root, "journal", dir, start.slice(0, 7)), { recursive: true });
    writeFileSync(join(root, "journal", dir, start.slice(0, 7), `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  };
  for (const run of runs)
    journal("tend", `run-${run.id}`, run.start, { format: "bigbrain-tend-run/v1", invocation_id: `run-${run.id}`, insertion_ids: [],
      model: run.model, started_at: run.start, completed_at: run.end });
  const live = prose.filter((p) => p.sources?.length);
  for (let k = 0; k < Math.max(1, total / 400); k++) {
    const batch = Array.from({ length: 12 }, () => pick(live));
    const record: FeedRecord = { format: "bigbrain-feed-run/v1", invocation_id: `feed-${k}`, assertions: batch.map((b) => b.id),
      entries: [...new Map(batch.map((b) => [b.sources![0]!.insertion_id, b])).values()].map((b) => ({
        source: b.sources![0]!.insertion_id, section: pick(["needs-you", "agent", "know", "skip"] as const),
        headline: b.text.replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, "$1"), due: chance(0.2) ? b.created_at.slice(0, 10) : null, assertions: [b.id],
      })), prompt_version: "feed/v3", started_at: at(clock += 10), completed_at: at(clock += 2), model: pick(MODELS) };
    journal("feed", `feed-${k}`, record.started_at, record);
  }

  // Memory topics: what the memory pass writes, citing assertions and linking entities and each other.
  const topics = Array.from({ length: Math.max(3, Math.trunc(total / 40)) }, (_, k) => `${pick(TOPICS).replace(/ /g, "-")}-${k}`);
  mkdirSync(join(root, "memory"), { recursive: true });
  for (const topic of topics) {
    const lines = Array.from({ length: 2 + int(5) }, () => {
      const cited = pick(prose), named = skewed(entities);
      return `- [[${named.label}]] ${pick(VERBS)} ${pick(TOPICS)} [[${cited.id}]]`;
    });
    if (chance(0.5)) lines.push(`- See [[${pick(topics)}]].`);
    writeFileSync(join(root, "memory", `${topic}.md`), `# ${topic.replace(/-\d+$/, "").replace(/-/g, " ")}\n\n${lines.join("\n")}\n`);
  }

  // One commit of everything, at a fixed time by a fixed author: the engine commits what it writes.
  const date = at(clock), env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  for (const args of [["init", "-q"], ["config", "user.name", "synthetic"], ["config", "user.email", "synthetic@example.invalid"],
    ["add", "-A"], ["commit", "-q", "-m", "A synthetic vault"]]) {
    const git = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    if (git.status !== 0) throw new Error(`syntheticVault: git ${args[0]}: ${git.stderr}`);
  }
  syncAssertionProjection(root);
  return { sources: sources.length, assertions: assertions.length, entities: entities.length, memory: topics.length, journals: runs.length };
}

function entity(label: string): AssertionEntity {
  return { id: assertionEntityId(label), label };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args.splice(i, 2)[1]) : undefined; };
  const sources = flag("sources"), seed = flag("seed");
  const [dir] = args;
  if (!dir || [sources, seed].some((n) => n !== undefined && !Number.isFinite(n))) {
    console.error("usage: bun test/support/syntheticVault.ts <empty dir> [--sources 2000] [--seed 1]");
    process.exit(2);
  }
  console.log(JSON.stringify(syntheticVault(dir, { sources, seed })));
}
