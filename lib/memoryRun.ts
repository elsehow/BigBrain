import type { PiSDK } from "./run/piSession";
type PiLoader = () => Promise<PiSDK>;
import { MemoryEdits } from "./memoryEdits";
import { choiceJournalFields } from "./modelResolution";
import type { ModelChoice } from "./modelChoice";
/** Memory consolidation through bounded Pi tools. Budget and citation gates
 * validate the memory tree; recovery restores only host-observed edits that
 * still match this run. Journals, publication, locks and cursor advancement
 * remain host-owned. No whole-vault quarantine or rollback occurs. */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { AST_CITE, SHARED_AST_CITE } from "./ids";
import type { Manifest } from "./manifest";
import { hasAssertionEvents } from "./assertionLog";
import { assertionIdsExist, syncAssertionProjection } from "./assertionProjection";
import { ENGINE_ROOT } from "./engine";
import { writeAtomic } from "./fsx";
import { commitPathsOnly, gitOut, pokePublish } from "./git";
import { canonicalizeScope, followRenames } from "./run/commit";
import { modelRunJournalFields, newRunId } from "./run/journal";
import { runModel, type ModelRunResult, type RunUsage } from "./run/model";
import type { RunMeter } from "./meterTypes";
import { sha256hex } from "./hash";
import { clip } from "./text";
import { proposeEntityFolds, readEntityFolds } from "./entityFolds";
import { readMemorySnapshot, renderMemoryContext, type MemorySnapshot } from "./memoryContext";
import { sharedCite, unknownSharedCitations, type SharedMemory } from "./sharedMemory";
import {
  describeBudget,
  measureTree,
  memoryTreeFiles,
  overBudget,
  trimPrompt,
  citationRepairPrompt,
  MEMORY_TRIM_ATTEMPTS,
} from "./memoryTree";
import {
  acquireMemoryLock,
  assertionAt,
  insertionAt,
  MEMORY_ROLE,
  MEMORY_PROTOCOL_VERSION,
  memoryDue,
  memoryNeedsRebuild,
  readMemoryStamp,
  releaseMemoryLock,
  writeMemoryStamp,
  type MemoryStamp,
} from "./memory";

const COMMIT_PATHS = ["memory", "journal/memory", "journal/retrieval", "journal/model-runs"];

export interface MemoryRunOpts {
  root: string;
  manifest: Manifest;
  /** run regardless of due-ness (a vault with no stamp is never auto-due) */
  force?: boolean;
  /** Production runners warm disposable Quick previews after successful commits. */
  warmBriefings?: boolean;
  /** the native regeneration posture (#459): run at cursor zero with the
   * old memory/ tree moved into an isolated backup first, so the record
   * alone is the input. Implies force — an explicit operator act. */
  fromScratch?: boolean;
  /** with fromScratch: back the tree up by COPY and leave it in place —
   * the one way old memory is ever an input to a regeneration. */
  keepTree?: boolean;
  /** SDK loader — tests replace transport, keeping the production session path */
  loadPi?: PiLoader;
}

export interface MemoryRunResult {
  /** false when the pass declined to run at all (not due, locked, unseeded) */
  ran: boolean;
  /** why it declined, or why it was due */
  reason: string;
  run?: string;
  error?: string;
  committed?: boolean;
  /** files under memory/ after the run */
  files?: number;
  /** words in the tree as the run left it (before any revert) */
  words?: number;
  /** trim turns the over-budget tree was handed back for (#598) */
  trims?: number;
  /** vault-relative from-scratch backup of the pre-run memory/ tree */
  backup?: string;
  /** links rewritten by the two mechanical rewriters */
  movesFollowed?: number;
  canonicalized?: number;
}

/** One trim turn (#598), as the journal records it. */
export interface TrimTurn {
  attempt: number;
  before: { files: number; words: number };
  after: { files: number; words: number };
  wallMs: number;
  usage?: RunUsage;
  meter?: RunMeter;
}

/** The report is the LAST ```report block — or the clipped tail when the
 * model wrote none. */
const lastReport = (text: string): string => {
  const blocks = [...text.matchAll(/```report\s*\n([\s\S]*?)```/g)];
  return blocks.length ? (blocks[blocks.length - 1]?.[1] ?? "").trim() : clip(text.trim(), 4_000, " …[clipped]");
};

function sumUsage(parts: (RunUsage | undefined)[]): RunUsage | undefined {
  const have = parts.filter((u): u is RunUsage => !!u);
  if (!have.length) return undefined;
  return have.reduce((a, b) => ({
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    turns: a.turns + b.turns,
    cost_usd: a.cost_usd === null || b.cost_usd === null ? null : a.cost_usd + b.cost_usd,
  }));
}

function journalTotals(run: ModelRunResult | undefined, trims: TrimTurn[], extra?: RunUsage): Record<string, unknown> {
  const usage = sumUsage([run?.usage, ...trims.map((t) => t.usage), extra]);
  const last = [...trims].reverse().find((t) => t.meter)?.meter;
  return {
    ...(usage ? { usage } : {}),
    ...(run?.meter && last ? { meter: { before: run.meter.before, after: last.after } } : {}),
  };
}

/** Can `git commit -- <path>` name this path at all? Existing on disk is
 * NOT enough: git rejects a pathspec matching nothing it knows, and an
 * empty untracked directory (a vault whose spool has never been written)
 * is exactly that — it passes existsSync and then fails every commit. So
 * ask git: does it track anything here, or see any change here? */
const committable = (root: string, path: string): boolean =>
  existsSync(join(root, path)) &&
  (!!gitOut(root, ["ls-files", "--", path]) ||
    !!gitOut(root, ["status", "--porcelain", "--", path]));

/** The budget gate (#598): measured, then HANDED BACK — not reverted on
 * sight. The revert stays, as the runaway guard behind MEMORY_TRIM_ATTEMPTS
 * trim turns that each see the exact overage; a $1–4 consolidation is not
 * thrown away over a few hundred words the model can cut in one turn when
 * told the number.
 *
 * Trims share the main turn's memory edit ledger. */
async function enforceBudget(args: {
  root: string;
  target: ModelChoice;
  auth: Manifest["auth"];
  /** the main turn's report; each trim's is appended to it */
  report: string;
  edits: MemoryEdits;
  loadPi?: PiLoader;
}): Promise<{
  measured: { files: number; words: number };
  trims: TrimTurn[];
  report: string;
  /** the trim turns' wall time, to add to the run's */
  wallMs: number;
  error?: string;
}> {
  const { root } = args;
  const trims: TrimTurn[] = [];
  let report = args.report;
  let wallMs = 0;
  let error: string | undefined;
  let measure = measureTree(root);

  for (let attempt = 1; !error && overBudget(measure) && attempt <= MEMORY_TRIM_ATTEMPTS; attempt++) {
    const before = measure;
    console.warn(
      `${MEMORY_ROLE}: over budget after the model returned — ${describeBudget(before)}; handing the tree back to trim (${attempt}/${MEMORY_TRIM_ATTEMPTS})`
    );
    const t1 = Date.now();
    let trimRun: ModelRunResult;
    try {
      trimRun = await runModel(
        {
          prompt: trimPrompt(before, attempt, report),
          root,
          role: MEMORY_ROLE,
          target: args.target, memoryEdits: args.edits,
          auth: args.auth,
        },
        args.loadPi
      );
    } catch (e) {
      // the tree is known over budget and nobody is left to fix it:
      // the runaway guard applies
      error = `trim ${attempt} failed: ${e instanceof Error ? e.message : String(e)} — run reverted`;
      args.edits.rollback();
      break;
    }
    const trimWall = Date.now() - t1;
    wallMs += trimWall;
    measure = measureTree(root);
    trims.push({
      attempt,
      before: { files: before.files.length, words: before.words },
      after: { files: measure.files.length, words: measure.words },
      wallMs: trimWall,
      ...(trimRun.usage ? { usage: trimRun.usage } : {}),
      ...(trimRun.meter ? { meter: trimRun.meter } : {}),
    });
    report += `\n\n## Trim ${attempt}\n\n${lastReport(trimRun.text)}`;
    console.log(
      `${MEMORY_ROLE}: trim ${attempt} — ${before.words} → ${measure.words} word(s), ${before.files.length} → ${measure.files.length} file(s)`
    );
  }

  if (!error && overBudget(measure)) {
    error = `over budget: ${describeBudget(measure)} after ${trims.length} trim turn(s) — run reverted`;
    args.edits.rollback();
  }
  return {
    measured: { files: measure.files.length, words: measure.words },
    trims,
    report,
    wallMs,
    ...(error ? { error } : {}),
  };
}

/** The citation gate (#459, Decision 3): the prompt states the convention,
 * code holds it. Every `[[ast_…]]` the tree cites must resolve in the
 * record, and a native run that folded new assertions must leave at least
 * one citation SOMEWHERE — code cannot parse claim-vs-prose, so per-line
 * coverage stays the prompt's contract, but a fully uncited native tree is
 * mechanical proof the convention was ignored.
 *
 * Runs AFTER the rewriters so it sees the committed bytes (the
 * canonicalizer leaves an unresolvable ast link exactly as written).
 * Returns the failure, or undefined when the tree is clean. */
interface CitationCheck {
  failure?: string;
  /** citations that resolve nowhere, as written — what a repair turn is shown */
  unknown: string[];
}
function citationCheck(root: string, foldedAssertions: number, shared: SharedMemory): CitationCheck {
  const citedAsts = new Set<string>();
  const citedShared: [string, string][] = [];
  for (const f of memoryTreeFiles(root)) {
    const text = readFileSync(join(root, "memory", f), "utf8");
    for (const m of text.matchAll(AST_CITE)) citedAsts.add(m[1]!);
    for (const m of text.matchAll(SHARED_AST_CITE)) citedShared.push([m[1]!, m[2]!]);
  }
  if (!citedAsts.size && !citedShared.length)
    return {
      unknown: [],
      ...(foldedAssertions
        ? { failure: `uncited tree: ${foldedAssertions} new assertion(s) folded and no memory line cites any [[ast_…]] or [[shared:…:ast_…]]` }
        : {}),
    };
  // A joined vault's claims resolve against its last-read view; one this
  // machine no longer joins resolves nowhere (lib/sharedMemory.ts).
  const unknownShared = unknownSharedCitations(shared, citedShared);
  let missing: string[] = [];
  if (citedAsts.size) {
    try {
      // .state/ is gitignored, so a fresh clone has no projection; the gate
      // must not fail a valid run over missing derived state. Sync is
      // incremental — a current projection pays two id scans.
      syncAssertionProjection(root);
      const known = assertionIdsExist(root, [...citedAsts]);
      missing = [...citedAsts].filter((id) => !known.has(id)).sort();
    } catch (e) {
      return { unknown: [], failure: `citation check failed: ${e instanceof Error ? e.message : e}` };
    }
  }
  const failure = [
    missing.length ? `unknown assertion citation(s): ${missing.join(", ")}` : "",
    unknownShared.length ? `unknown shared-vault citation(s): ${unknownShared.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return { unknown: [...missing, ...unknownShared], ...(failure ? { failure } : {}) };
}

/** A bare `[[ast_…]]` that is no assertion of this vault but is exactly one
 * joined vault's claim is that claim, cited without its vault: name the
 * vault (`[[shared:<vault>:ast_…]]`). Ids are content hashes, so the match
 * is never a guess; an id no vault or several vaults hold is left as
 * written, for the repair turn. Returns the citations rewritten. */
function qualifySharedCitations(root: string, shared: SharedMemory, edits: MemoryEdits): number {
  const holders = new Map<string, string[]>();
  for (const v of shared.vaults) for (const a of v.assertions) holders.set(a.id, [...(holders.get(a.id) ?? []), v.id]);
  if (!holders.size) return 0;
  const files = memoryTreeFiles(root);
  const bare = new Set<string>();
  for (const f of files) for (const m of readFileSync(join(root, "memory", f), "utf8").matchAll(AST_CITE)) if (holders.get(m[1]!)?.length === 1) bare.add(m[1]!);
  if (!bare.size) return 0;
  syncAssertionProjection(root);
  const personal = assertionIdsExist(root, [...bare]);
  let rewritten = 0;
  edits.capture(files.map((f) => `memory/${f}`), () => {
    for (const f of files) {
      const path = join(root, "memory", f), text = readFileSync(path, "utf8");
      const next = text.replace(AST_CITE, (cite: string, id: string) => {
        if (personal.has(id) || holders.get(id)?.length !== 1) return cite;
        rewritten++;
        return `[[${sharedCite(holders.get(id)![0]!, id)}${cite.slice(2 + id.length)}`;
      });
      if (next !== text) writeAtomic(path, next);
    }
  });
  return rewritten;
}

/** The run's journal record. Its FIELDS are the run's own knowledge; this
 * is the writing of them. */
function writeMemoryJournal(root: string, runId: string, record: Record<string, unknown>): void {
  const dir = join(root, "journal", "memory");
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

export async function runMemory(opts: MemoryRunOpts): Promise<MemoryRunResult> {
  const { root, manifest } = opts;

  const verdict = memoryDue(root, {
    force: (opts.force ?? false) || (opts.fromScratch ?? false),
  });
  if (!verdict.due) {
    console.log(`${MEMORY_ROLE}: not due — ${verdict.reason}`);
    return { ran: false, reason: verdict.reason };
  }

  // ONE source of prompt text: the engine's. A vault copy used to win here
  // and in lib/tend.ts, which is how a `memory.md` frozen at 2026-08-28
  // outlived four engine fixes on the vault it was curating — seeding
  // stopped in #524, but nothing shed what a vault already had, and the
  // readers kept preferring it. `bigbrain install` sheds them now
  // (lib/scaffold.ts shedVaultPrompts).
  const templatePath = join(ENGINE_ROOT, "prompts", "memory.md");

  if (!acquireMemoryLock(root)) return { ran: false, reason: "another memory run holds the lock" };

  const startedAt = new Date();
  const runId = newRunId(startedAt);
  let warmCompletedMemory = false;

  const edits = new MemoryEdits(root);
  try {
    const template = readFileSync(templatePath, "utf8");
    const stamp = readMemoryStamp(root);
    // A tree from an older protocol is selected again from the record: the
    // run that finds it rebuilds, the same posture as --from-scratch.
    const upgrade = !opts.fromScratch && memoryNeedsRebuild(root, stamp);
    if (upgrade) console.log(`${MEMORY_ROLE}: memory protocol ${stamp.protocolVersion ?? 0} → ${MEMORY_PROTOCOL_VERSION}; rebuilding from scratch`);
    const fromScratch = Boolean(opts.fromScratch) || upgrade;
    if (fromScratch && !hasAssertionEvents(root)) {
      const reason =
        "--from-scratch is the native regeneration posture — this vault has no assertion events to regenerate from";
      console.error(`${MEMORY_ROLE}: ${reason}`);
      return { ran: false, reason, error: reason };
    }
    // From-scratch (#459): the old tree survives ONLY as an isolated
    // migration backup — MOVED out of memory/ so it cannot be an input to
    // the regeneration, unless --keep-tree explicitly selects it (then a
    // copy). journal/memory/ is runner-owned and committed with the run,
    // and nothing ever reads it as input.
    let backupRel: string | undefined;
    if (fromScratch && existsSync(join(root, "memory"))) {
      backupRel = `journal/memory/pre-native-backup-${runId}`;
      mkdirSync(join(root, "journal", "memory"), { recursive: true });
      if (opts.keepTree) cpSync(join(root, "memory"), join(root, backupRel), { recursive: true });
      else {
        edits.capture(memoryTreeFiles(root).map(f => `memory/${f}`), () => {
          renameSync(join(root, "memory"), join(root, backupRel!));
        });
        // the rename takes the directory with it; leave the empty target so
        // the run writes into memory/, not around it
        mkdirSync(join(root, "memory"));
      }
    }
    // From-scratch runs at cursor zero — that IS the regeneration posture,
    // not a transition hack. The stamp on disk is rewritten only on
    // success, so a failed regeneration leaves the old cursors (and, via
    // conditional recovery, the old tree) in place for a clean retry.
    const cursors = {
      ...(!fromScratch && stamp.checkpoint ? { checkpoint: stamp.checkpoint } : {}),
      ...(!fromScratch && stamp.lastRunAt ? { lastRunAt: stamp.lastRunAt } : {}),
      ...(fromScratch ? {} : stamp.assertionCursor ? { assertionCursor: stamp.assertionCursor } : {}),
      ...(fromScratch ? {} : stamp.insertionCursor ? { insertionCursor: stamp.insertionCursor } : {}),
      ...(fromScratch ? { fromScratch: true } : {}),
    };
    // Read ONCE, before the model runs (lib/memoryContext.ts): the delta
    // the prompt renders and the cursors the stamp advances to come from
    // the SAME listing, so an event landing mid-run stays past the cursor
    // for the next run instead of being silently skipped.
    const snapshot: MemorySnapshot = readMemorySnapshot(root, cursors);
    const { asts, inss, astDelta, unasserted, voiceNotes, firstRun, bootstrap, sharedFresh } = snapshot;
    const prompt = template + renderMemoryContext(root, snapshot, cursors);
    const deltaDesc = bootstrap
      ? fromScratch
        ? "from scratch"
        : "first run"
      : `${astDelta.length} assertion event(s)`;
    const sharedDesc = sharedFresh.length ? `, ${sharedFresh.length} shared-vault assertion(s)` : "";
    console.log(
      `${MEMORY_ROLE}: run ${runId} — ${verdict.reason}; ${deltaDesc}${sharedDesc}, ${voiceNotes.length} voice, model ${manifest.memory.model}`
    );

    let error: string | undefined;
    let report = "";
    let result = "";
    let movesFollowed = 0;
    let canonicalized = 0;
    const t0 = Date.now();
    let run: ModelRunResult | undefined;
    try {
      run = await runModel(
        {
          prompt,
          root,
          role: MEMORY_ROLE,
          target: manifest.memory, memoryEdits: edits,
          auth: manifest.auth,
        },
        opts.loadPi
      );
      result = run.text;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    let wallMs = Date.now() - t0;
    const trims: TrimTurn[] = [];
    let measured: { files: number; words: number } | undefined;


    if (!error) {
      report = lastReport(result);

      const budget = await enforceBudget({
        root,
        target: manifest.memory,
        auth: manifest.auth,
        report,
        edits,
        ...(opts.loadPi ? { loadPi: opts.loadPi } : {}),
      });
      report = budget.report;
      trims.push(...budget.trims);
      measured = budget.measured;
      wallMs += budget.wallMs;
      error = budget.error;


    }

    // The editor's two rewriters, on the memory pass's own tree — and they
    // matter MORE here. memory/ is where the markdown-path habit lived
    // (the amputated namespace once made wikilinks impossible), and topic
    // files link to EACH OTHER as of 2026-08-06, so a renamed topic
    // strands its siblings' links exactly the way a renamed dossier used
    // to strand the record's. Both run after the budget check, so a
    // reverted tree is never rewritten, and neither ever guesses.
    const rewrite = () => {
      // Inspect renames through a private index; both rewriters stay in memory.
      const paths = memoryTreeFiles(root).map(f => `memory/${f}`);
      edits.capture(paths, () => {
        movesFollowed += followRenames(root, MEMORY_ROLE, ["memory"]);
        canonicalized += canonicalizeScope(root, MEMORY_ROLE, paths);
      });
    };
    if (!error) rewrite();

    // The citation gate. A bare citation of a joined vault's claim is named
    // mechanically; what still resolves nowhere — a mistyped id, most often —
    // is handed back once with the list (#113), as the budget hands back an
    // overage. Still unresolved, it is enforced like the budget: revert,
    // journal, loud — the spool stays pending and the next due tick retries.
    let qualified = 0;
    let citationRepair: Record<string, unknown> | undefined;
    let repairUsage: RunUsage | undefined;
    if (!error) {
      const shared: SharedMemory = { vaults: snapshot.sharedVaults };
      const folded = astDelta.length + sharedFresh.length;
      qualified += qualifySharedCitations(root, shared, edits);
      let check = citationCheck(root, folded, shared);
      if (check.unknown.length) {
        console.warn(`${MEMORY_ROLE}: ${check.failure}; handing the tree back to repair them`);
        const t3 = Date.now();
        try {
          const fix = await runModel(
            { prompt: citationRepairPrompt(check.unknown), root, role: MEMORY_ROLE, target: manifest.memory, memoryEdits: edits, auth: manifest.auth },
            opts.loadPi
          );
          repairUsage = fix.usage;
          rewrite();
          qualified += qualifySharedCitations(root, shared, edits);
          const after = citationCheck(root, folded, shared);
          report += `\n\n## Citation repair\n\n${lastReport(fix.text)}`;
          citationRepair = { unknown: check.unknown, ...(after.unknown.length ? { unresolved: after.unknown } : {}), wallMs: Date.now() - t3, ...(fix.usage ? { usage: fix.usage } : {}) };
          check = after;
          // the repair holds to the budget too
          const remeasured = measureTree(root);
          measured = { files: remeasured.files.length, words: remeasured.words };
          if (!check.failure && overBudget(remeasured)) check = { unknown: [], failure: `over budget after the citation repair: ${describeBudget(remeasured)}` };
        } catch (e) {
          citationRepair = { unknown: check.unknown, error: e instanceof Error ? e.message : String(e), wallMs: Date.now() - t3 };
          check = { ...check, failure: `${check.failure}; the repair turn failed` };
        }
        wallMs += Date.now() - t3;
        console.log(`${MEMORY_ROLE}: citation repair — ${check.failure ?? "every citation resolves"}`);
      }
      if (check.failure) {
        error = `${check.failure} — run reverted`;
        edits.rollback();
      }
    }

    // The pass's second job (#728): the labels that name one thing, as
    // proposals for the operator (lib/entityFolds.ts). After the gates, so
    // a reverted sweep proposes nothing; on the sweep's model; over the
    // entities that gained a claim since the last proposal, no tools, one
    // turn. Its failure is its own — journaled under `folds`, never the
    // sweep's error: a fold missed today is proposed tomorrow, and a day's
    // memory is not worth losing over it. Its spend counts toward the run's.
    let folds: Record<string, unknown> | undefined;
    let foldsUsage: RunUsage | undefined;
    if (!error) {
      const t2 = Date.now();
      try {
        const since = readEntityFolds(root)?.proposedAt;
        const r = await proposeEntityFolds(root, {
          target: manifest.memory,
          auth: manifest.auth,
          ...(since !== undefined ? { since } : {}),
          ...(opts.loadPi ? { loadPi: opts.loadPi } : {}),
        });
        foldsUsage = r.ran ? r.folds.usage : undefined;
        folds = {
          ran: r.ran,
          changed: r.changed,
          census: r.folds.census,
          groups: r.folds.groups.length,
          dropped: r.folds.dropped.length,
          ...(r.ran && r.folds.sessionId ? { session: r.folds.sessionId } : {}),
          ...(foldsUsage ? { usage: foldsUsage } : {}),
          wallMs: Date.now() - t2,
        };
        if (r.ran) console.log(`${MEMORY_ROLE}: folds — ${r.changed} entity(ies) in the question, ${r.folds.groups.length} group(s) standing`);
      } catch (e) {
        folds = { error: e instanceof Error ? e.message : String(e), wallMs: Date.now() - t2 };
        console.warn(`${MEMORY_ROLE}: folds failed — ${folds["error"]}`);
      }
    }

    const nextRunAt = new Date(Date.now() + manifest.memory.intervalMs).toISOString();
    const lastAst = asts.at(-1);
    const lastIns = inss.at(-1);
    const nextStamp: MemoryStamp | undefined = error
      ? stamp.nextRunAt ? { ...stamp, nextRunAt } : undefined
      : {
          lastRunAt: startedAt.toISOString(), nextRunAt, run: runId,
          protocolVersion: (fromScratch && !opts.keepTree) || firstRun
            ? Math.max(MEMORY_PROTOCOL_VERSION, stamp.protocolVersion ?? 0)
            : stamp.protocolVersion,
          checkpoint: snapshot.checkpoint,
          ...(lastAst ? { assertionCursor: { at: assertionAt(lastAst), id: lastAst.id } }
            : stamp.assertionCursor ? { assertionCursor: stamp.assertionCursor } : {}),
          ...(lastIns ? { insertionCursor: { at: insertionAt(lastIns), id: lastIns.id } }
            : stamp.insertionCursor ? { insertionCursor: stamp.insertionCursor } : {}),
        };

    writeMemoryJournal(root, runId, {
      ...(nextStamp ? { memoryStamp: nextStamp } : {}),
      run: runId,
      startedAt: startedAt.toISOString(),
      mode: fromScratch ? "from-scratch" : firstRun ? "bootstrap" : "incremental",
      ...(backupRel ? { backup: backupRel } : {}),
      protocolVersion: MEMORY_PROTOCOL_VERSION,
      ...choiceJournalFields(manifest.memory),
      agent: manifest.memory.adapter,
      auth: manifest.memory.adapter === "pi" ? "pi-managed" : manifest.auth,
      // Live results supersede the requested identity and auth mode.
      ...(run ? modelRunJournalFields(run) : {}),
      // the trim turns (#598) are part of the run: their spend adds to
      // `usage` (what `bigbrain econ` sums), the plan meter's bracket
      // closes after the last of them, and each is listed with what it
      // was asked to cut and what it cut
      ...(trims.length ? { trims } : {}),
      // a citation repair turn (#113) is part of the run the same way
      ...(citationRepair ? { citationRepair } : {}),
      ...(trims.length || foldsUsage || repairUsage ? journalTotals(run, trims, sumUsage([foldsUsage, repairUsage])) : {}),
      ...(folds ? { folds } : {}),
      // the tree as the run left it, before any revert — the size
      // trajectory is answerable from the journal, run by run
      ...(measured ? { tree: measured } : {}),
      promptSha256: sha256hex(prompt),
      // the delta this run folded, and the inbox it was shown
      assertionChanges: astDelta.length,
      unasserted: unasserted.length,
      voice: voiceNotes.map((i) => i.id),
      wallMs,
      // the mechanical rewrites are part of the run's audit trail: the
      // committed record differs from what the model wrote, and the
      // journal is where that is answerable
      ...(movesFollowed ? { movesFollowed } : {}),
      ...(canonicalized ? { canonicalized } : {}),
      ...(qualified ? { qualified } : {}),
      ...(report ? { report } : {}),
      ...(error ? { error } : {}),
    });

    if (error) {
      const conflicts = edits.rollback();
      if (conflicts.length) console.warn(`memory: preserved concurrent edits: ${conflicts.join(", ")}`);
      console.error(`${MEMORY_ROLE}: run failed — ${error}`);
      // A failed run takes the interval's slot (2026-09-03). ONLY the clock
      // moves: the cursors, lastRunAt, lastCommit and `run` still name the
      // last run that FOLDED, so the retry sees the same delta — and is
      // told what killed this one (previousRunFailure). Before this, the
      // stamp was untouched on failure, nextRunAt stayed in the past, and
      // the next five-minute tick was due again: a run that died at the
      // background-job timeout, or a tree still over budget after its trims,
      // re-ran and re-paid every tick until something changed (#598
      // measured $1–4 a revert). Silent by design — the stamp and the
      // journal say so, and diagnostics reads both (lib/diagnostics.ts).
      // A vault not yet on the clock (no stamp: the first run is --force,
      // and it failed) stays off it.
      if (nextStamp) writeMemoryStamp(root, nextStamp);
      // same shape on both paths — a caller reading `canonicalized` should
      // not have to know whether the run failed to know it was 0
      return {
        ran: true,
        reason: verdict.reason,
        run: runId,
        error,
        ...(backupRel ? { backup: backupRel } : {}),
        files: memoryTreeFiles(root).length,
        ...(measured ? { words: measured.words } : {}),
        trims: trims.length,
        movesFollowed,
        canonicalized,
      };
    }

    const changed = memoryTreeFiles(root).length;
    const committed = commitPathsOnly(
      root,
      MEMORY_ROLE,
      `${MEMORY_ROLE}: ${bootstrap ? "bootstrap" : "sweep"} — ${changed} file(s), ${voiceNotes.length} voice note(s)`,
      COMMIT_PATHS.filter((p) => committable(root, p))
    );

    // The committed journal carries the checkpoint; .state is its cache.
    writeMemoryStamp(root, {
      ...nextStamp!,
      lastCommit: committed ? gitOut(root, ["rev-parse", "HEAD"]) : stamp.lastCommit,
    });
    if (committed) pokePublish(root);
    warmCompletedMemory = !!opts.warmBriefings;
    console.log(
      `${MEMORY_ROLE}: done — ${changed} file(s) in tree${committed ? ", committed" : ", no changes"}`
    );
    return {
      ran: true,
      reason: verdict.reason,
      run: runId,
      committed,
      ...(backupRel ? { backup: backupRel } : {}),
      files: changed,
      ...(measured ? { words: measured.words } : {}),
      trims: trims.length,
      movesFollowed,
      canonicalized,
    };
  } catch (error) {
    edits.rollback();
    throw error;
  } finally {
    releaseMemoryLock(root);
    if (warmCompletedMemory) {
      try {
        const { warmMemoryBriefings } = await import("./memoryBriefings");
        await warmMemoryBriefings(root);
      } catch (error) { console.warn("Quick memory preview warming failed:", error); }
    }

  }
}
