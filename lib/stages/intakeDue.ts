/** intakeDue.ts — what the gardener (lib/stages/intake.ts) is waiting on,
 * kept apart from the stage's run so that the work tools, the tick and the
 * viewer's count read it without loading the gardener's session. */
import { syncAssertionProjection } from "../assertionProjection";
import { withSnapshot } from "../vaultReadModel";
import { intakeCandidates, intakeSettled, type IntakeItem, type IntakeSettled } from "../views/intake";
import type { Snapshot } from "../views/view";
import { waiting, type RecordViews } from "./stage";

/** What intake works on and has settled, as views. */
export const INTAKE: RecordViews<IntakeItem, IntakeSettled> = {
  output: "record",
  inputs: (snapshot) => intakeCandidates(snapshot).map((item) => ({ id: item.insertion_id, hash: item.insertion_id, item })),
  written: intakeSettled,
  settles: (out) => [out.insertion_id],
};

/** The landings waiting for the gardener, in the order it is handed them:
 * what `next` hands out, what a round diffs, what the viewer counts. */
export const waitingIntake = (snapshot: Snapshot): IntakeItem[] => waiting(INTAKE, snapshot).map((input) => input.item);

export function dueIntake(root: string): string[] {
  syncAssertionProjection(root);
  return withSnapshot(root, (snapshot) => waitingIntake(snapshot).map((item) => item.insertion_id));
}

