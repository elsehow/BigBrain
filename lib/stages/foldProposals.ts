/** foldProposals.ts — the fold proposals' stage (#728; lib/entityFolds.ts
 * has the census, the validation, the read and the operator's doors): one
 * model turn over the census, its groups validated and written to
 * `.state/entity-folds.json`, a memo whose loss costs only a proposal — the
 * operator's identity assertion settles a fold, never this file. Run by the
 * supervisor as the folds chain (lib/chains.ts), and by `bigbrain entity
 * folds --propose`. */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectFolds } from "../assertionProjection";
import { ENGINE_ROOT } from "../engine";
import {
  entityCensus, entityFoldsFile, parseFolds, rawGroup, readEntityFolds, rejectedPairList, rejectedPairs, renderFoldsPrompt, validateFolds,
  changedSince, type EntityFolds, type RejectedPair,
} from "../entityFolds";
import { writeAtomic } from "../fsx";
import type { Auth } from "../manifest";
import { MEMORY_ROLE } from "../memory";
import type { ModelChoice } from "../modelChoice";
import { asModelRun, modelRequest } from "../run/model";
import type { PiSDK } from "../run/piSession";
import { withVaultSnapshot } from "../vaultReadModel";
import { modelRunner } from "./runner";
import type { ModelRunner } from "./stage";

type PiLoader = () => Promise<PiSDK>;

export interface ProposeOpts {
  target: ModelChoice;
  auth: Auth;
  /** SDK loader — tests replace transport, keeping the production session path */
  loadPi?: PiLoader;
  /** The runner the chain hands the stage; the session job through `loadPi` by default. */
  model?: ModelRunner;
  /** the clock's shape: only entities with a claim after this are the
   * question, and standing proposals are kept. Absent: the whole census,
   * fresh — `--propose`, and a vault's first pass. */
  since?: string;
  rejected?: RejectedPair;
  now?: () => Date;
  /** the prompt template; the engine's prompts/entity-folds.md by default */
  template?: string;
}

export interface ProposeResult {
  folds: EntityFolds;
  /** the model ran — false when a delta had no question in it */
  ran: boolean;
  /** entities in the question */
  changed: number;
}

/** Run the feeder once: census → model → validated groups → the state
 * file. The model runs as the memory pass (its role, its runner). */
export async function proposeEntityFolds(root: string, opts: ProposeOpts): Promise<ProposeResult> {
  const [census, refused] = withVaultSnapshot(root, (db) => [entityCensus(root, db), rejectedPairList(db)] as const);
  const rejected = opts.rejected ?? rejectedPairs(refused);
  const now = opts.now ?? (() => new Date());
  const standing = opts.since !== undefined ? readEntityFolds(root) : undefined;
  const changed = opts.since !== undefined ? changedSince(census, opts.since).length : census.length;
  // stamped when the census is READ, not when the model returns: the next
  // delta starts here, so a claim that lands during the run is in it
  const proposedAt = now().toISOString();
  const t0 = Date.now();
  const template = opts.template ?? readFileSync(join(ENGINE_ROOT, "prompts", "entity-folds.md"), "utf8");
  const prompt = census.length < 2 ? null : renderFoldsPrompt(template, census, opts.since);
  if (prompt === null) {
    // nothing to ask: the standing proposals, re-read against today, stand
    const kept = standing
      ? { ...standing, ...validateFolds(standing.groups.map(rawGroup), census, rejected) }
      : { proposedAt, model: opts.target.model, census: census.length, groups: [], dropped: [], wallMs: 0 };
    write(root, kept);
    return { folds: kept, ran: false, changed };
  }
  const model = opts.model ?? modelRunner(opts.loadPi);
  const run = asModelRun(await model(modelRequest({ prompt, root, target: opts.target, role: MEMORY_ROLE, auth: opts.auth, noTools: true })));
  // standing groups first: a member already proposed is not re-proposed,
  // and a group settled or emptied since falls out here
  const { groups, dropped } = validateFolds(
    [...(standing?.groups ?? []).map(rawGroup), ...(parseFolds(run.text) as unknown[])],
    census,
    rejected
  );
  const folds: EntityFolds = {
    proposedAt,
    model: opts.target.model,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    census: census.length,
    groups,
    dropped,
    ...(run.usage ? { usage: run.usage } : {}),
    wallMs: Date.now() - t0,
  };
  write(root, folds);
  return { folds, ran: true, changed };
}

function write(root: string, folds: EntityFolds): void {
  mkdirSync(join(root, ".state"), { recursive: true });
  writeAtomic(entityFoldsFile(root), `${JSON.stringify(folds, null, 2)}\n`);
  projectFolds(root);
}
