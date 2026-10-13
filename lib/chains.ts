/** The registered chains (lib/chain.ts), in the order a tick reports them.
 * The classic chain is first: `bigbrain tend --json` keeps its result at the
 * top level, the contract the Claude plugin's /bigbrain:tend reads.
 *
 * Every stage that calls a model runs from here, on the supervisor's clock
 * (docs/plans/2026-10-12-stages-and-views-refactor.md, R3): each chain is a
 * job of its own (lib/desktopSchedule.ts CADENCE, by `job`), so none waits
 * on another. Before, copy judging was a job of its own, lens scoring and
 * the worth gate ran on the viewer's 30-second timer, and fold proposals and
 * briefing warming rode inside the memory pass. A chain is due when its
 * stage has work its own output does not settle: a pair no judgment
 * settles, a staged item no admission has taken, an entity that gained a
 * claim since the last proposal, a memory sweep no warming has followed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduledVerdict, type Chain, type ChainReport, type ChainRunOpts } from "./chain";
import { changedSince, entityCensus, proposeEntityFolds, readEntityFolds } from "./entityFolds";
import { ensureDir, writeAtomic } from "./fsx";
import { admissionWaiting, tickIntegrationAdmission } from "./integrationAdmission";
import { listLenses } from "./lenses";
import { tickLenses } from "./lensSync";
import { loadManifest } from "./manifest";
import { readMemoryStamp } from "./memory";
import { tickPublishing } from "./sharedAssertionPublish";
import { connectionStorePath, readConnections } from "./sharedConnections";
import { judgeCopies } from "./sourceCopyJudge";
import { classicChain } from "./tend";
import { unjudgedCopies, withVaultSnapshot } from "./vaultReadModel";

const ok = (lines: string[]): ChainReport => ({ lines, failed: false });
const failed = (name: string, error: unknown): ChainReport =>
  ({ lines: [], failed: true, error: `${name}: ${error instanceof Error ? error.message : String(error)}` });
/** A chain's run, its failure kept as its result: one chain failing never fails another. */
const attempt = async <T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> => {
  try { return { value: await run() }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
};

/** Pairs that might be one document, judged by Jev or Quick (lib/sourceCopyJudge.ts). */
export const copiesChain: Chain<{ value?: Awaited<ReturnType<typeof judgeCopies>>; error?: string }> = {
  name: "copies",
  job: "copies",
  due: (root) => ({ source: unjudgedCopies(root).length, scheduled: {} }),
  run: ({ root }) => attempt(() => judgeCopies(root, connectionStorePath())),
  report: ({ value, error }) => error ? failed("copies", error) : ok(value && (value.judged || value.failed)
    ? [`copies: ${value.judged} judged${value.failed ? `, ${value.failed} failed` : ""}${value.left > value.judged ? `, ${value.left - value.judged} left` : ""}`] : []),
};

/** The labels that name one thing, proposed to the owner (lib/entityFolds.ts),
 * on the memory pass's model and interval: due once memory has run, and then
 * when an entity has gained a claim since the last proposal and the interval
 * since it has passed. */
export const foldsChain: Chain<{ value?: Awaited<ReturnType<typeof proposeEntityFolds>>; error?: string }> = {
  name: "folds",
  job: "folds",
  due(root, opts = {}) {
    const standing = readEntityFolds(root);
    const nextRunAt = standing ? new Date(Date.parse(standing.proposedAt) + loadManifest(root).memory.intervalMs).toISOString()
      : readMemoryStamp(root).lastRunAt;
    return { source: 0, scheduled: { folds: scheduledVerdict({
      ...(opts.now ? { now: opts.now } : {}), ...(nextRunAt ? { nextRunAt } : {}),
      idle: "no entity gained a claim since the last proposal",
      work: () => {
        const census = withVaultSnapshot(root, (db) => entityCensus(root, db));
        const changed = standing ? changedSince(census, standing.proposedAt).length : census.length;
        return changed ? `${changed} entit${changed === 1 ? "y" : "ies"} changed` : undefined;
      },
    }) } };
  },
  run: ({ root, manifest }: ChainRunOpts) => attempt(() => {
    const since = readEntityFolds(root)?.proposedAt;
    return proposeEntityFolds(root, { target: manifest.memory, auth: manifest.auth, ...(since !== undefined ? { since } : {}) });
  }),
  report: ({ value, error }) => error ? failed("folds", error)
    : ok(value?.ran ? [`folds: ${value.changed} entit${value.changed === 1 ? "y" : "ies"} in the question, ${value.folds.groups.length} group(s) standing`] : []),
};

/** Quick previews of what the memory pass wrote (lib/memoryBriefings.ts):
 * due when a sweep has run since the last warming. A memo: its loss costs
 * only asking again. */
const warmedFile = (root: string) => join(root, ".state", "briefings-warmed.json");
const warmedAfter = (root: string): string | undefined => {
  try { return (JSON.parse(readFileSync(warmedFile(root), "utf8")) as { memoryRunAt?: string }).memoryRunAt; } catch { return undefined; }
};
export const briefingsChain: Chain<{ value?: { warmed: number; failures: string[] }; error?: string; memoryRunAt?: string }> = {
  name: "briefings",
  job: "briefings",
  due(root) {
    const swept = readMemoryStamp(root).lastRunAt;
    return { source: swept && swept !== warmedAfter(root) ? 1 : 0, scheduled: {} };
  },
  async run({ root }) {
    const memoryRunAt = readMemoryStamp(root).lastRunAt;
    const result = await attempt(async () => (await import("./memoryBriefings")).warmMemoryBriefings(root));
    if (!result.error && memoryRunAt) {
      ensureDir(join(root, ".state"));
      writeAtomic(warmedFile(root), JSON.stringify({ memoryRunAt }));
    }
    return { ...result, ...(memoryRunAt ? { memoryRunAt } : {}) };
  },
  report: ({ value, error }) => error ? failed("briefings", error)
    : ok(value ? [`briefings: ${value.warmed} warmed${value.failures.length ? `, ${value.failures.length} failed` : ""}`] : []),
};

/** Each lens's scoring and summaries, its sync with the servers it is
 * shared to, then publishing to them (lib/lensSync.ts,
 * lib/sharedAssertionPublish.ts): due while there is a lens or a server. */
export const lensesChain: Chain<{ value?: void; error?: string }> = {
  name: "lenses",
  job: "lenses",
  due(root) {
    const store = connectionStorePath();
    return { source: listLenses(root, store).length + readConnections(store).length, scheduled: {} };
  },
  run: ({ root }) => attempt(async () => {
    const store = connectionStorePath();
    await tickLenses(root, store);
    await tickPublishing(root, store);
  }),
  report: ({ error }) => error ? failed("lenses", error) : ok([]),
};

/** What integrations staged, through the worth gate when it is on
 * (lib/integrationAdmission.ts): due while an item waits. */
export const admissionChain: Chain<{ value?: void; error?: string }> = {
  name: "admission",
  job: "admission",
  due: (root) => ({ source: admissionWaiting(root), scheduled: {} }),
  run: ({ root }) => attempt(() => tickIntegrationAdmission(root)),
  report: ({ error }) => error ? failed("admission", error) : ok([]),
};

export const CHAINS: readonly Chain[] = [classicChain, copiesChain, foldsChain, briefingsChain, lensesChain, admissionChain] as Chain[];

/** The chain a supervisor job ticks. */
export const chainOfJob = (job: string): Chain | undefined => CHAINS.find((chain) => chain.job === job);
