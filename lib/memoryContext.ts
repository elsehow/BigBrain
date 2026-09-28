/**
 * memoryContext.ts — what the memory pass is SHOWN: the snapshot it folds,
 * and the run context appended to prompts/memory.md.
 *
 * Split out of lib/memoryRun.ts (#640), where ~200 lines of prompt
 * assembly sat inside the run body between the lock and the model call.
 * The two belong together and apart from the run: the snapshot is read
 * ONCE and both the prompt and the cursor advance come from it, which is
 * the invariant that keeps an event landing mid-run from being skipped —
 * it stays past the cursor for the next run instead.
 *
 * Nothing here writes. It reads the logs, the tree and the last journal.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertionSourceReferences,
  type AssertionEvent,
} from "./assertionLog";
import { latestUserIdentity } from "./userIdentity";
import { assertionEntityPath } from "./assertionEntityView";
import type { SourceInsertion, SourceMetadata } from "./insertionLog";
import { insertionAt, type LogCursor } from "./memory";
import { readMemoryInputs, memoryInputDelta, type MemoryCheckpoint, type MemoryPosition } from "./memoryInputs";
import {
  MEMORY_MAX_FILES,
  MEMORY_MAX_WORDS,
  MEMORY_TARGET_WORDS,
  MEMORY_TRIM_ATTEMPTS,
  measureTree,
} from "./memoryTree";
import { clip, str } from "./text";
import { aboutIds, isVoiceKind } from "./voiceFacts";

/** Native prompt-block bounds: past these, the delta is summarized rather
 * than inlined — a backlog must not turn the run context into a corpus
 * dump (the model has search over the record for anything elided). */
export const MEMORY_MAX_ASSERTIONS_INLINE = 200;
export const MEMORY_MAX_ARRIVALS_INLINE = 50;

/** The record as this run sees it, read ONCE before the model runs: the
 * delta the prompt renders and the cursors the stamp advances to come from
 * the SAME listing, so an event landing mid-run stays past the cursor for
 * the next run instead of being silently skipped. */
export interface MemorySnapshot {
  checkpoint: MemoryCheckpoint;
  recordChanged: boolean;
  /** the whole logs, in reader order — the cursor advance reads their tails */
  asts: AssertionEvent[];
  inss: SourceMetadata[];
  /** assertion events past the cursor: what this run folds */
  astDelta: AssertionEvent[];
  /** "arrived, not yet asserted" — inbox awareness, never working-set
   * input (Decision 2): feeding raw arrivals to the most expensive pass
   * would re-do extraction inside it */
  unasserted: SourceMetadata[];
  /** the user's own channel (#521), past the same cursor */
  voiceNotes: SourceInsertion[];
  firstRun: boolean;
  /** first run or from-scratch: the record survey replaces the delta */
  bootstrap: boolean;
}

export interface SnapshotOpts extends MemoryPosition {
  fromScratch?: boolean;
}

export function readMemorySnapshot(root: string, opts: SnapshotOpts): MemorySnapshot {
  const inputs = readMemoryInputs(root);
  const { asts, inss, superseded, checkpoint } = inputs;
  const delta = memoryInputDelta(inputs, opts.fromScratch ? {} : opts);
  const citedIns = new Set(
    asts.flatMap((e) => assertionSourceReferences(e).map((r) => r.insertion_id))
  );
  // a superseded landing is never "unasserted": its successor is the one
  // intake files (lib/sourceSupersede.ts)
  const firstRun = !existsSync(join(root, "memory", "MEMORY.md"));
  return {
    asts,
    inss,
    checkpoint,
    recordChanged: delta.recordChanged,
    astDelta: delta.astDelta,
    unasserted: inss.filter(
      (i) =>
        delta.unseenInsertion(i) &&
        !citedIns.has(i.id) &&
        !superseded.has(i.id) &&
        !isVoiceKind(i.envelope["kind"])
    ),
    voiceNotes: delta.voiceNotes,
    firstRun,
    bootstrap: firstRun || (opts.fromScratch ?? false),
  };
}

const voiceLine = (i: SourceInsertion): string => {
  const env = i.envelope as Record<string, unknown>;
  const grade =
    env["from_kind"] === "person"
      ? " (person — the user's verbatim words)"
      : env["from_kind"] === "agent"
        ? " (agent — a relay; data, not the user's voice)"
        : "";
  const q = str(env["query"]) ? `\n  query: ${clip(String(env["query"]), 300, " …[clipped]")}` : "";
  const ab = aboutIds(env).length ? `\n  about: ${aboutIds(env).join(", ")}` : "";
  return `- id: ${i.id}\n  at: ${insertionAt(i)}\n  kind: ${env["kind"]}\n  from: ${str(env["from"]) ?? i.author.id}${grade}${q}${ab}\n  text: ${clip(i.body, 2_000, " …[clipped]")}`;
};

/** The native semantic delta, one assertion per entry: id (the citation
 * handle), confidence, created_at, the text with its canonical
 * [[ent_…]] links INTACT (the validator caps it at one 2,000-char line,
 * and clipping could sever a link mid-token), and the cited sources'
 * titles. */
const astLine = (e: AssertionEvent, titleOf: Map<string, string>): string => {
  const titles = [
    ...new Set(assertionSourceReferences(e).map((r) => titleOf.get(r.insertion_id) ?? r.source_id)),
  ];
  return `- ${e.id} · ${e.confidence} · ${e.created_at}\n  text: ${e.text}\n  sources: ${clip(titles.join("; "), 300, " …[clipped]")}`;
};

/** The newest journaled run, when it failed: what the next run is told
 * (#598). A discarded run leaves the tree and the inputs exactly as they
 * were, so without this the retry is a blind re-draw — the same prompt,
 * the same tree, and no idea the last attempt died 200 words over. */
export function previousRunFailure(
  root: string
): { run: string; at: string | null; error: string } | null {
  const dir = join(root, "journal", "memory");
  if (!existsSync(dir)) return null;
  const newest = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .pop();
  if (!newest) return null;
  try {
    const j = JSON.parse(readFileSync(join(dir, newest), "utf8")) as {
      run?: string;
      startedAt?: string;
      error?: string;
    };
    return typeof j.error === "string" && j.error
      ? {
          run: j.run ?? newest.replace(/\.json$/, ""),
          at: typeof j.startedAt === "string" ? j.startedAt : null,
          error: j.error,
        }
      : null;
  } catch {
    return null;
  }
}

/** The run context appended to prompts/memory.md: the mode, the budget
 * with the tree's current standing, the previous run's failure if there
 * was one, the user's dossier, the voice channel, and the record delta. */
export function renderMemoryContext(
  root: string,
  snapshot: MemorySnapshot,
  opts: { fromScratch?: boolean; assertionCursor?: LogCursor }
): string {
  const { asts, inss, astDelta, unasserted, voiceNotes, firstRun, bootstrap } = snapshot;

  // Voice is inlined on EVERY mode, bootstrap included (#686). The
  // elision used to fire here too, on the theory that a from-scratch
  // survey would cover it — but voice is the record's rarest and
  // highest-ranked signal (5 person-stamped arrivals among the canary's
  // 1,247), and telling a run "4 exist, go find them" bought nothing and
  // cost it several turns grepping raw JSON for them. The cap below is
  // what bounds this block; it always did.
  const shownVoice = voiceNotes.slice(-MEMORY_MAX_ARRIVALS_INLINE);
  const voiceBlock = voiceNotes.length
    ? [
        ...(voiceNotes.length > shownVoice.length
          ? [`(${voiceNotes.length - shownVoice.length} earlier voice arrival(s) elided — search the record for them)`]
          : []),
        ...shownVoice.map(voiceLine),
      ].join("\n")
    : "(none)";

  // Bootstrap elides the full-history dump the same way the legacy first
  // run does — the survey covers the record itself.
  const titleOf = new Map(inss.map((i) => [i.id, i.title] as const));
  const shownAsts = astDelta.slice(-MEMORY_MAX_ASSERTIONS_INLINE);
  const assertionsBlock = bootstrap
    ? `(${opts.fromScratch ? "from scratch" : "first run"} — survey the record; ${asts.length} assertion event(s) exist under log/assertions/)`
    : astDelta.length
      ? [
          ...(astDelta.length > shownAsts.length
            ? [
                `(${astDelta.length - shownAsts.length} earlier assertion(s) since the cursor elided — search the record for them rather than guessing)`,
              ]
            : []),
          ...shownAsts.map((e) => astLine(e, titleOf)),
        ].join("\n")
      : "(no new assertions since the last run)";
  const shownIns = unasserted.slice(0, MEMORY_MAX_ARRIVALS_INLINE);
  const arrivalsBlock = unasserted.length
    ? [
        ...shownIns.map(
          (i) => `- ${clip(i.title, 200, " …[clipped]")}${insertionAt(i) ? ` (${insertionAt(i)})` : ""}`
        ),
        ...(unasserted.length > shownIns.length
          ? [`…and ${unasserted.length - shownIns.length} more`]
          : []),
      ].join("\n")
    : "(none)";

  // Who the vault is about (#572): the newest identity declaration, rendered
  // as a link the working set can cite plus the aliases that recognize the
  // person — never prose, which a poisoned arrival could amplify. Absent
  // until first run or `bigbrain whoami --declare` has been answered. The
  // editor-era `human_user` dossier is not read here any more (#683):
  // `bigbrain whoami --adopt-dossier` folds what it held into the declaration.
  const me = latestUserIdentity(root);
  const userBlock = me
    ? `
## The user

- ${assertionEntityPath(me.entity_id)} — ${me.name}${me.aliases.length ? ` (aliases: ${me.aliases.join(", ")})` : ""}

These aliases help identify the user. Attribute words using the source's
author and recorded speaker labels, following the prompt's attribution rules.
`
    : "";

  const mode = opts.fromScratch
    ? "FROM SCRATCH — cursor zero; regenerate memory/ from the record alone"
    : firstRun
      ? "FIRST RUN — memory/ does not exist yet; bootstrap it"
      : `incremental (assertion cursor: ${opts.assertionCursor?.id ?? "none"})`;
  const recordBlocks = `## New assertions since cursor (${astDelta.length})

${assertionsBlock}

## Arrived, not yet asserted (${unasserted.length})

Inbox awareness only — their assertions arrive with extraction; do not
mine raw sources here.

${arrivalsBlock}
`;
  // Where the tree stands and what the line is, in numbers (#598): the
  // model plans its cuts against the headroom instead of discovering
  // the gate when the runner reverts it. A discarded previous run is
  // named too — its work is gone and this run sees the same inputs.
  const startMeasure = measureTree(root);
  const headroom = MEMORY_MAX_WORDS - startMeasure.words;
  const standing = bootstrap
    ? ""
    : ` The tree stands at ${startMeasure.words} words in ${startMeasure.files.length} files now — ${
        headroom >= 0 ? `${headroom} words of headroom` : `${-headroom} words over the line already`
      }.`;
  const prevFailure = previousRunFailure(root);
  return `

---

# This run

- Mode: ${mode}.
${snapshot.recordChanged ? "- The record has corrections, withdrawals, or identity changes since the last checkpoint. Re-read the current record and reconcile existing memory claims, including claims whose original sources or assertions no longer stand.\n" : ""}
- Size limits: aim for ${MEMORY_TARGET_WORDS} words or fewer; maximum
  ${MEMORY_MAX_WORDS} words and ${MEMORY_MAX_FILES} files across memory/.
  Each citation counts as one word. The runner allows ${MEMORY_TRIM_ATTEMPTS}
  trimming attempts before discarding an oversized result.${standing}
${
  prevFailure
    ? `- The previous run (${prevFailure.run}) was discarded — ${prevFailure.error}.
  Its work is gone and this run sees the same inputs.
`
    : ""
}${userBlock}
## Voice since cursor (${voiceNotes.length})

Requests and observations received since the checkpoint. Attribute them
using the source author and speaker labels; agent-authored entries are relays.

${voiceBlock}

${recordBlocks}`;
}
