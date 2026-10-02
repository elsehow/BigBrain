/** A memory checkpoint records the events actually observed by one run.
 * Event timestamps describe content and may be backdated; they are not
 * reliable positions in a growing log. Legacy cursors remain readable. */
import { assertionSourceReferences, readAssertionLog } from "./assertionLog";
import { readSourceInsertionLog } from "./insertionLog";
import { readRevocationLog } from "./revocationLog";
import { readEntityAliasLog } from "./entityAliasLog";
import { isVoiceKind } from "./voiceFacts";
import { memoryReadModel } from "./vaultReadModel";
import { assertionSuperseded, supersededInsertionIds } from "./sourceSupersede";
import type { SharedCheckpoint } from "./sharedMemory";

export interface LogCursor { at: string; id: string }

export interface MemoryCheckpoint {
  assertions: string[];
  insertions: string[];
  revocations: string[];
  aliases: string[];
  /** Per joined shared vault (lib/sharedMemory.ts); absent before any. */
  shared?: Record<string, SharedCheckpoint>;
}

export interface MemoryPosition {
  assertionCursor?: LogCursor;
  insertionCursor?: LogCursor;
  checkpoint?: MemoryCheckpoint;
  lastRunAt?: string;
}

export const pastCursor = (at: string, id: string, cursor?: LogCursor): boolean =>
  !cursor || at > cursor.at || (at === cursor.at && id > cursor.id);

/** Capture each input once; the runner checkpoints these same arrays after
 * success, so an event arriving during the run remains unseen. */
export function readMemoryInputs(root: string) {
  let events: ReturnType<typeof memoryReadModel>;
  try { events = memoryReadModel(root); }
  catch {
    // Preserve the memory pass's tolerant recovery policy. If the projection
    // cannot reconcile, read each log once and checkpoint exactly those events.
    // This degraded path has the old filesystem consistency, not a DB snapshot.
    const sources = readSourceInsertionLog(root);
    events = { inss: sources.map(({ body: _body, ...metadata }) => metadata),
      voice: sources.filter(e => isVoiceKind(e.envelope.kind)),
      asserted: readAssertionLog(root, { includeRevoked: true }),
      revocations: readRevocationLog(root), aliases: readEntityAliasLog(root) };
  }
  const { inss, asserted, voice, revocations, aliases } = events;
  const revoked = new Set(revocations.map((e) => e.assertion_id));
  const held = new Set(inss.map((e) => e.id));
  const superseded = supersededInsertionIds(inss);
  const asts = asserted.filter((e) => !revoked.has(e.id) && !assertionSuperseded(
    assertionSourceReferences(e).map((r) => r.insertion_id), superseded, (id) => held.has(id)
  ));
  const checkpoint: MemoryCheckpoint = {
    assertions: asts.map((e) => e.id),
    insertions: inss.map((e) => e.id),
    revocations: revocations.map((e) => e.id),
    aliases: aliases.map((e) => e.id),
  };
  return { asts, inss, voice, superseded, revocations, aliases, checkpoint };
}

export type MemoryInputSnapshot = ReturnType<typeof readMemoryInputs>;

export function memoryInputDelta(inputs: MemoryInputSnapshot, position: MemoryPosition) {
  const prior = position.checkpoint;
  const seenAssertions = new Set(prior?.assertions);
  const seenInsertions = new Set(prior?.insertions);
  // An old successful run has no event census. Reconcile once at its
  // normal scheduled interval instead of guessing which backdated events
  // it saw. Cursor-only callers retain the legacy interpretation.
  const reconcile = !prior && Boolean(position.lastRunAt);
  const astDelta = inputs.asts.filter((e) => prior ? !seenAssertions.has(e.id)
    : reconcile || pastCursor(e.created_at, e.id, position.assertionCursor));
  const unseenInsertion = (e: MemoryInputSnapshot["inss"][number]): boolean => prior
    ? !seenInsertions.has(e.id)
    : pastCursor(e.received_at ?? e.occurred_at ?? "", e.id, position.insertionCursor);
  const voiceNotes = inputs.voice.filter(unseenInsertion);
  const changed = (before: string[], after: string[]): boolean => {
    const ids = new Set(before);
    return ids.size !== after.length || after.some((id) => !ids.has(id));
  };
  const liveAssertions = new Set(inputs.checkpoint.assertions);
  const recordChanged = reconcile || Boolean(prior && (
    changed(prior.revocations, inputs.checkpoint.revocations) ||
    changed(prior.aliases, inputs.checkpoint.aliases) ||
    prior.assertions.some((id) => !liveAssertions.has(id))
  ));
  return { astDelta, voiceNotes, unseenInsertion, recordChanged };
}
