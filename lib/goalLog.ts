/** Append-only goal events — the goal chain's own log (#51, lib/goalChain.ts).
 *
 * One event per gardened arrival, carrying that arrival's typed assertions:
 * `assertion` holds only what the source says, `relevance` why it may matter
 * (which may lean on the picture). An empty list is the decline — the
 * arrival was read and yielded nothing — so the log stays homogeneous and
 * every arrival the chain has answered is cited exactly here.
 *
 * Its OWN directory, never `log/assertions/`: a citation there would settle
 * the arrival for the classic chain, and that log's readers validate it
 * strictly as entity-linked `assertion.asserted` (the declineLog.ts reason).
 *
 * Host code constructs and validates events; models never write this log
 * directly. The append/read/commit machinery is lib/eventLog.ts.
 */

import type { AssertionProduction } from "./assertionLog";
import { eventLog, type AppendResult } from "./eventLog";
import { sha256hex } from "./hash";
import { validEventAuthor, type EventAuthor } from "./insertionLog";

export const GOAL_LOG_DIR = "log/goal-assertions";

export const GOAL_ASSERTION_TYPES = ["about_goals", "action_space"] as const;
export type GoalAssertionType = (typeof GOAL_ASSERTION_TYPES)[number];

export interface GoalAssertion {
  type: GoalAssertionType;
  /** Only what this source says. Never refers to the picture. */
  assertion: string;
  /** Why it may be relevant; may refer to the picture. */
  relevance: string;
}

export interface GoalEvent {
  event: "goal.gardened";
  id: string;
  insertion_id: string;
  source_id: string;
  /** Empty: read, and nothing in it bears on the goals (the decline). */
  assertions: GoalAssertion[];
  /** The picture run this arrival was read against; absent before the first. */
  picture?: string;
  author: EventAuthor;
  created_at: string;
  produced_by: AssertionProduction;
}

export type GoalAppendResult = AppendResult<GoalEvent>;

const TEXT_MAX = 4_000;

export function validateGoalEvent(event: GoalEvent): void {
  if (event.event !== "goal.gardened" || !/^gol_[a-f0-9]{24}$/u.test(event.id))
    throw new Error("goal-log: invalid event identity");
  if (!event.insertion_id?.trim() || !event.source_id?.trim())
    throw new Error("goal-log: an insertion and its source are required");
  if (!Array.isArray(event.assertions)) throw new Error("goal-log: assertions must be a list");
  for (const a of event.assertions) {
    if (!GOAL_ASSERTION_TYPES.includes(a.type)) throw new Error("goal-log: unknown assertion type");
    if (typeof a.assertion !== "string" || !a.assertion.trim() || a.assertion.length > TEXT_MAX)
      throw new Error(`goal-log: assertion must be 1-${TEXT_MAX} characters`);
    if (typeof a.relevance !== "string" || a.relevance.length > TEXT_MAX)
      throw new Error(`goal-log: relevance must be at most ${TEXT_MAX} characters`);
  }
  if (!validEventAuthor(event.author)) throw new Error("goal-log: invalid author");
  if (!event.produced_by?.procedure?.trim() || !event.produced_by.version?.trim())
    throw new Error("goal-log: production procedure and version are required");
}

const log = eventLog<GoalEvent>({
  name: "goal",
  dir: GOAL_LOG_DIR,
  when: (event) => event.created_at,
  validate: validateGoalEvent,
});

/** Construct an immutable goal event. The identity excludes `created_at`, so
 * a retried write of the same answer converges on the same file. */
export function createGoalEvent(input: Omit<GoalEvent, "event" | "id">): GoalEvent {
  const assertions = input.assertions.map((a) => ({
    type: a.type, assertion: a.assertion.trim(), relevance: a.relevance.trim(),
  }));
  const { created_at: _, ...identity } = { ...input, assertions };
  const event: GoalEvent = {
    event: "goal.gardened",
    id: `gol_${sha256hex(JSON.stringify(identity)).slice(0, 24)}`,
    ...input,
    assertions,
  };
  validateGoalEvent(event);
  return event;
}

export const goalEventRel = log.rel;

export const appendGoalEvent = log.append;

export const readGoalLog = log.read;

export const commitGoalEvents = log.commit;
