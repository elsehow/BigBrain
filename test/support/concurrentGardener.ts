/** Scratch-only experiment. No production caller, persistent queue or alternate
 * filing implementation: ownership wraps the normal shared tool handlers. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { acquireAssertionLock, releaseAssertionLock, ownerLabelsFor, ASSERTION_AGENT_TIMEOUT_MS } from '../../lib/assertionAgent';
import { runAgent } from '../../lib/run/agent';
import type { AgentRunResult } from '../../lib/run/model';
import type { ModelRunRequest } from '../../lib/run/request';
import type { Manifest } from '../../lib/manifest';
import { tendPrompt, type TendResult } from '../../lib/tend';
import { dueIntakeIds, nextWork, WORK_BATCH_LIMIT, type SubmitResult, type WorkItem } from '../../lib/work';
import { stagedIds } from '../../lib/stage';
import { instrumentVaultTools } from './profileVaultTools';

export const gardenerLane = new AsyncLocalStorage<number>();
const key = (item: WorkItem) => item.job.kind === 'intake' ? item.job.insertion_id : item.job.kind === 'staged' ? item.job.id : '';

/** All calls reach the same validators. Serialize queue reads and mutations so
 * admission ownership is installed before another lane can ask for work. */
export class GardenerAssignments {
  private owners = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(items: WorkItem[]) {
    const intake = items.filter(i => i.job.kind === 'intake');
    if (intake.length < 2 || intake.length > WORK_BATCH_LIMIT) throw new Error('Experiment requires 2–8 intake arrivals');
    const sources = new Set<string>();
    for (const [i, item] of intake.entries()) {
      if (item.job.kind !== 'intake' || !('insertion' in item.inputs)) throw new Error('Invalid intake');
      if (item.inputs.voice?.length || item.inputs.about?.length || item.inputs.supersedes || sources.has(item.job.source_id))
        throw new Error('Experiment excludes related voice, revision and same-source jobs');
      sources.add(item.job.source_id);
      // Preserve the normal three-arrival batch boundaries for this cohort.
      this.owners.set(key(item), Math.floor(i / 3) % 2);
    }
    if (![...this.owners.values()].includes(1)) this.owners.set(key(intake.at(-1)!), 1);
    for (const item of items) if (item.job.kind === 'staged') this.owners.set(key(item), 0);
  }
  owned(id: string, lane: number): boolean { return this.owners.get(id) === lane; }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  select(items: WorkItem[], lane: number, limit: number): WorkItem[] {
    let intake = 0;
    for (const item of items) if (!this.owners.has(key(item))) throw new Error('Unassigned arrival entered bounded experiment');
    return items.filter(item => this.owned(key(item), lane) && (item.job.kind !== 'intake' || intake++ < limit));
  }
  validate(name: string, args: Record<string, any>, lane: number): void {
    const allOwned = (ids: unknown) => Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === 'string' && this.owned(id, lane));
    if (name === 'open') {
      if (!allOwned(args.ids)) throw new Error('Cannot open another lane’s staged arrival');
    } else if (name === 'submit') {
      if (!Array.isArray(args.items)) throw new Error('Expected submission items');
      for (const item of args.items) {
        if (item.submit === 'assertion') {
          if (!Array.isArray(item.sources) || !item.sources.some((id: string) => this.owned(id, lane))
            || item.sources.some((id: string) => this.owners.has(id) && !this.owned(id, lane)))
            throw new Error('Assertion must file own arrival, without citing another lane’s arrival');
        } else if (!['decline', 'admit', 'pass'].includes(item.submit)
          || !allOwned(item.submit === 'decline' ? item.insertion_ids : item.staged_ids))
          throw new Error('Cannot settle unassigned work');
      }
    }
  }
  admitted(result: SubmitResult, lane: number): void {
    for (const item of result.results) for (const staged of item.staged ?? []) {
      if (staged.ok && 'insertion_id' in staged && staged.insertion_id) {
        const previous = this.owners.get(staged.insertion_id);
        if (previous !== undefined && previous !== lane) throw new Error('Admission collided with another lane');
        this.owners.set(staged.insertion_id, lane);
      }
    }
  }
}

export async function runConcurrentGardener(root: string, manifest: Manifest,
  run: (request: ModelRunRequest) => Promise<AgentRunResult> = runAgent): Promise<TendResult> {
  root = realpathSync(root);
  if (!basename(root).startsWith('bb-gardener-profile-') || !existsSync(join(root, '.benchmark-snapshot')))
    throw new Error('Concurrent experiment requires a marked scratch vault');
  if (!acquireAssertionLock(root)) throw new Error('Another gardener holds the lock');
  let restore: (() => void) | undefined;
  try {
    const before = dueIntakeIds(root), stages = stagedIds(root);
    const items = nextWork(root, { kinds: ['intake', 'staged'], limit: WORK_BATCH_LIMIT });
    if (before.length + stages.length > WORK_BATCH_LIMIT || items.length !== before.length + stages.length) throw new Error('Experiment cohort exceeds one host batch');
    const assignment = new GardenerAssignments(items);
    restore = instrumentVaultTools((tool, handler) => async (ctx, args) => {
      const lane = gardenerLane.getStore();
      if (realpathSync(ctx.root) !== root || (lane !== 0 && lane !== 1)) throw new Error('Tool escaped assigned session');
      if (!['next', 'open', 'submit'].includes(tool.name)) return handler(ctx, args);
      return assignment.serial(async () => {
        assignment.validate(tool.name, args, lane);
        if (tool.name === 'next') {
          const limit = args.limit ?? 3;
          if (!Number.isInteger(limit) || limit < 1 || limit > WORK_BATCH_LIMIT) throw new Error('Invalid batch size');
          const all = await handler(ctx, { ...args, limit: WORK_BATCH_LIMIT }) as WorkItem[];
          return assignment.select(all, lane, limit as number);
        }
        const result = await handler(ctx, args);
        if (tool.name === 'submit') assignment.admitted(result as SubmitResult, lane);
        return result;
      });
    });
    const prompt = tendPrompt(ownerLabelsFor(root));
    // allSettled is intentional: do not drop the lock or restore handlers while
    // a surviving sibling can still file. Failed work remains due in the logs.
    const outcomes = await Promise.allSettled([0, 1].map(lane => gardenerLane.run(lane, () => run({
      root, role: 'tend', auth: manifest.auth, prompt, capabilities: 'gardener',
      target: manifest.gardener,
      timeoutMs: ASSERTION_AGENT_TIMEOUT_MS,
    }))));
    const remaining = new Set([...dueIntakeIds(root), ...stagedIds(root)]);
    return { ran: true, rounds: outcomes.map((outcome, lane) => ({
      runId: `benchmark-lane-${lane}`, settled: [...before, ...stages].filter(id => assignment.owned(id, lane) && !remaining.has(id)).length,
      remaining: [...remaining].filter(id => assignment.owned(id, lane)).length,
      ...(outcome.status === 'fulfilled' ? { usage: outcome.value.usage } : { error: String(outcome.reason) }),
    })) };
  } finally { restore?.(); releaseAssertionLock(root); }
}
