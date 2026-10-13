/** stage.ts — what a stage is (docs/plans/2026-10-11-field-of-assertions.md,
 * "Stages and views" and "Types"; docs/plans/2026-10-12-stages-and-views-refactor.md,
 * "Record or memo").
 *
 * A stage calls a model. It works through the items its own output does not
 * yet settle (design principle 2: work is a view, not a queue) and writes
 * what the model said, because a model call cannot be run again for the
 * same answer. Only stages call models, and only stages and doors write.
 *
 * Where its output goes is the one choice a stage makes:
 * - the RECORD, when anything must agree on it: another stage reads it, or it
 *   decides what a server receives. What it wrote settles its inputs.
 * - a MEMO, a cache keyed by the stage's version and its input's content
 *   hash, whose loss costs only asking again. No stage reads a memo as input.
 *
 * Whether a stage has work is then one function of these types (`waiting`),
 * not one per chain.
 */
import type { AgentRunResult } from "../run/model";
import type { ModelRunRequest } from "../run/request";
import type { Snapshot, View } from "../views/view";

/** One item a stage may work on. `id` is what an output settles; `hash` is
 * its content's, which a memo is keyed by: the same content judged twice
 * costs no model call. */
export interface StageInput<In> {
  readonly id: string;
  readonly hash: string;
  readonly item: In;
}

/** The one way a stage reaches a model. A stage is handed it; nothing else is. */
export type ModelRunner = (request: ModelRunRequest) => Promise<AgentRunResult>;

/** A record stage's write: an append, typed to the kinds it writes. */
export interface RecordWrite<Out> {
  append(out: Out): void;
}

/** A memo stage's write: an answer for one input, under the stage's version. */
export interface MemoWrite<Out> {
  put(input: StageInput<unknown>, out: Out): void;
}

/** Read access to a memo stage's answers, by `memoKey`. */
export interface MemoStore<Out> {
  get(key: string): Out | undefined;
}

/** What a run is handed: its write, and the model runner when it asks one
 * through the background jobs rather than through an evaluator of its own.
 * Not a snapshot: a run awaits models, and a snapshot is a transaction a
 * read holds only while it reads. What a stage reads it reads first, in
 * `waiting`, and it is handed that batch. */
export interface StageContext<W> {
  readonly model?: ModelRunner;
  readonly write: W;
}

interface StageBase<In, W> {
  readonly name: string;
  /** Moves when the prompt or the answer's shape does; a memo is keyed by it. */
  readonly version: string;
  /** Everything the stage could work on: its `In`, and all it may take as evidence. */
  readonly inputs: View<readonly StageInput<In>[]>;
  run(context: StageContext<W>, batch: readonly StageInput<In>[]): Promise<void>;
}

export interface RecordStage<In, Out> extends StageBase<In, RecordWrite<Out>> {
  readonly output: "record";
  /** What this stage has written, read back from the record. */
  readonly written: View<readonly Out[]>;
  /** The input ids an output settles. */
  settles(out: Out): readonly string[];
}

export interface MemoStage<In, Out> extends StageBase<In, MemoWrite<Out>> {
  readonly output: "memo";
}

export type Stage<In, Out> = RecordStage<In, Out> | MemoStage<In, Out>;

/** Where a memo stage's answer for an input is kept. */
export const memoKey = (stage: Pick<Stage<unknown, unknown>, "name" | "version">, input: Pick<StageInput<unknown>, "hash">): string =>
  `${stage.name}@${stage.version}:${input.hash}`;

/** The inputs a stage has not answered: for a record stage, those none of
 * its outputs settles; for a memo stage, those with no answer under its
 * version. A stage is due when this is not empty. */
export function waiting<In, Out>(stage: RecordStage<In, Out>, snapshot: Snapshot): StageInput<In>[];
export function waiting<In, Out>(stage: MemoStage<In, Out>, snapshot: Snapshot, memo: MemoStore<Out>): StageInput<In>[];
export function waiting<In, Out>(stage: Stage<In, Out>, snapshot: Snapshot, memo?: MemoStore<Out>): StageInput<In>[] {
  const inputs = stage.inputs(snapshot);
  if (stage.output === "memo") return inputs.filter((input) => memo!.get(memoKey(stage, input)) === undefined);
  const settled = new Set(stage.written(snapshot).flatMap((out) => stage.settles(out)));
  return inputs.filter((input) => !settled.has(input.id));
}
