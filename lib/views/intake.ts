/** intake.ts — what intake may work on, and what it has settled
 * (docs/plans/2026-10-12-stages-and-views-refactor.md, R11; the stage is
 * lib/stages/intake.ts).
 *
 * Every live landing with an intake priority is an input, in the order the
 * gardener is handed them (priority, then when it arrived). A landing is
 * settled once an assertion cites it — a retracted one too: what it settled
 * stays settled — or a standing decline names it. What is waiting is the
 * one difference (lib/stages/stage.ts `waiting`).
 */
import type { IntakeClass } from "../intakeClass";
import { liveSourceSql } from "../sourceSupersede";
import type { Snapshot } from "./view";

/** One landing as intake is handed it. */
export interface IntakeItem {
  insertion_id: string;
  source_id: string;
  title: string;
  /** The rank's class, or `agent-chat`: a session whose owner's side is the item. */
  class: IntakeClass | "agent-chat";
  /** The insertion-log reader's sort key (`received_at ?? occurred_at`). */
  at: string;
}

/** What settles a landing: a claim citing it, or a decline naming it. */
export interface IntakeSettled {
  insertion_id: string;
}

export function intakeCandidates({ db }: Snapshot): IntakeItem[] {
  return db.query(`SELECT s.insertion_id, s.source_id, s.title, s.intake_at AS at, s.intake_class AS class FROM sources s
    WHERE s.intake_priority IS NOT NULL AND ${liveSourceSql("s")}
    ORDER BY s.intake_priority, s.intake_at, s.insertion_id`).all() as IntakeItem[];
}

export function intakeSettled({ db }: Snapshot): IntakeSettled[] {
  return db.query(`SELECT insertion_id FROM assertion_sources
    UNION SELECT insertion_id FROM declines WHERE retracted_by IS NULL`).all() as IntakeSettled[];
}
