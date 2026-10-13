/** intake.ts — the gardener (docs/plans/2026-10-12-stages-and-views-refactor.md,
 * R11): the classic chain's first stage, which files what arrived.
 *
 * Its inputs are the landings with an intake priority, and a landing is
 * settled once a claim cites it or a decline names it (lib/views/intake.ts),
 * so what is waiting is `waiting(intakeStage, snapshot)`: the one definition
 * the tick, the viewer's count and the run itself read. Its write is the
 * gardener's session tools (lib/vaultTools.ts): the model pulls batches with
 * `next` and settles them with `submit` and `decline`, each landing in the
 * record the moment it is called, so a killed round loses at most one
 * unsubmitted batch. Staged arrivals (#744), which sit outside the vault by
 * design, are the round's other work: it admits or passes them.
 *
 * A run is bounded rounds, each one model session, each journaled
 * (journal/tend/) and committed with what it settled.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSERTION_AGENT_TIMEOUT_MS, ownerLabelsFor } from "../assertionAgent";
import { projectJournal } from "../assertionProjection";
import { ENGINE_ROOT } from "../engine";
import { ensureDir, writeAtomic } from "../fsx";
import { startGardenerProgress } from "../gardenerProgress";
import type { Manifest } from "../manifest";
import type { RunMeter } from "../meterTypes";
import { choiceJournalFields } from "../modelResolution";
import { render } from "../prompts";
import { modelRunJournalFields, newRunId } from "../run/journal";
import type { AgentRunResult, RunUsage } from "../run/model";
import { TEND_JOURNAL_DIR } from "../runJournal";
import { commitRunRecords } from "../runRecords";
import { stagedIds } from "../stage";
import type { IntakeItem, IntakeSettled } from "../views/intake";
import { INTAKE, dueIntake } from "./intakeDue";
import type { ModelRunner, RecordStage, RecordWrite, StageContext } from "./stage";

export { dueIntake };

export const TEND_PROMPT_VERSION = "tend/v5";

/** Bounded rounds per run: each round is one provider session draining
 * available `next` batches. A backlog drains tick by tick; a stuck model that
 * settles nothing ends the run after ONE wasted round, not four. */
export const TEND_MAX_ROUNDS = 4;

/** Render the engine-owned gardener prompt. */
export function tendPrompt(ownerLabels: readonly string[]): string {
  const template = readFileSync(join(ENGINE_ROOT, "prompts", "tend.md"), "utf8");
  const owner = ownerLabels.length
    ? `The vault owner is known by these labels: ${ownerLabels.join(", ")}. Use these to identify the owner; check source authorship before attributing words to them.`
    : "No vault-owner identity labels were supplied.";
  return render(template, { OWNER: owner });
}

/** One round's journal record — meter-normalizable (lib/meter.ts
 * reads this format beside the assertion journals; engine/sampling ride
 * explicitly so telemetry labels the era without inference). */
export interface TendRunRecord {
  format: "bigbrain-tend-run/v1";
  invocation_id: string;
  /** The insertions THIS round settled (due before, not due after). */
  insertion_ids: string[];
  /** The staged arrivals this round admitted or passed (#744). */
  staged_ids?: string[];
  model: string;
  auth: string;
  engine: string;
  sampling: string;
  reasoning: string;
  prompt_version: string;
  started_at: string;
  completed_at: string;
  wall_ms: number;
  usage?: RunUsage;
  meter?: RunMeter;
  error?: { message: string };
}

function journalRecord(root: string, record: TendRunRecord): string {
  const rel = `${TEND_JOURNAL_DIR}/${record.completed_at.slice(0, 7)}/${record.invocation_id}.json`;
  ensureDir(join(root, TEND_JOURNAL_DIR, record.completed_at.slice(0, 7)));
  writeAtomic(join(root, rel), `${JSON.stringify(record)}\n`);
  projectJournal(root, rel); // the v2 feed names models from these
  commitRunRecords(root, { dir: TEND_JOURNAL_DIR, role: "tend", summary: `tend: run ${record.invocation_id} (${record.model})` });
  return rel;
}

export interface TendRound {
  runId: string;
  settled: number;
  remaining: number;
  usage?: RunUsage;
  error?: string;
}

export type IntakeStage = RecordStage<IntakeItem, IntakeSettled> & { rounds: TendRound[] };

/** The stage for one run: rounds while anything is waiting or staged, at
 * most `maxRounds`; a round that settles nothing ends it. Its caller holds
 * the gardener's lock. `rounds` is what the run did. */
export function intakeStage(opts: { root: string; manifest: Manifest; maxRounds?: number; now?: () => Date }): IntakeStage {
  const stage: IntakeStage = {
    ...INTAKE, name: "intake", version: TEND_PROMPT_VERSION, rounds: [],
    async run(context) { stage.rounds = await rounds(opts, context); },
  };
  return stage;
}

async function rounds(opts: { root: string; manifest: Manifest; maxRounds?: number; now?: () => Date },
  context: StageContext<RecordWrite<IntakeSettled>>): Promise<TendRound[]> {
  const { root, manifest } = opts;
  const model: ModelRunner | undefined = context.model;
  if (!model) throw new Error("intake: no model runner");
  const now = opts.now ?? (() => new Date());
  const rounds: TendRound[] = [];
  let before = dueIntake(root);
  let beforeStaged = stagedIds(root);
  const labels = ownerLabelsFor(root);
  for (let round = 0; round < (opts.maxRounds ?? TEND_MAX_ROUNDS) && before.length + beforeStaged.length; round++) {
    const runId = newRunId(now());
    const startedAt = now().toISOString();
    let call: AgentRunResult | undefined;
    let error: string | undefined;
    const progress = startGardenerProgress(root);
    try {
      call = await model({ root, role: "tend", auth: manifest.auth, prompt: tendPrompt(labels), target: manifest.gardener,
        capabilities: "gardener", timeoutMs: ASSERTION_AGENT_TIMEOUT_MS, onTool: progress.observe });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally { progress.finish(); }
    const after = dueIntake(root);
    const stillDue = new Set(after);
    const settledIds = before.filter((id) => !stillDue.has(id));
    const afterStaged = stagedIds(root);
    const stillStaged = new Set(afterStaged);
    const settledStaged = beforeStaged.filter((id) => !stillStaged.has(id));
    journalRecord(root, {
      format: "bigbrain-tend-run/v1",
      invocation_id: runId,
      insertion_ids: settledIds,
      ...(settledStaged.length ? { staged_ids: settledStaged } : {}),
      ...choiceJournalFields(manifest.gardener),
      auth: manifest.gardener.adapter === "pi" ? "pi-managed" : manifest.auth,
      prompt_version: TEND_PROMPT_VERSION,
      started_at: startedAt,
      completed_at: now().toISOString(),
      wall_ms: call?.wallMs ?? 0,
      ...(call ? modelRunJournalFields(call) : {}),
      ...(call?.meter ? { meter: call.meter } : {}),
      ...(error ? { error: { message: error.slice(0, 2_000) } } : {}),
    });
    rounds.push({
      runId, settled: settledIds.length + settledStaged.length, remaining: after.length + afterStaged.length,
      ...(call ? modelRunJournalFields(call) : {}), ...(error ? { error } : {}),
    });
    if (error) break;
    // No progress means a bigger batch won't help — a claim the journal
    // now evidences. The next tick retries fresh. (Settled, not counted:
    // an admitted arrival leaves the stage and joins the due set, so the
    // total can hold steady in a round that did real work.)
    if (!settledIds.length && !settledStaged.length) break;
    before = after;
    beforeStaged = afterStaged;
  }
  return rounds;
}
