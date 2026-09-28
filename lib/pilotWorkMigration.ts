import { createHash } from "node:crypto";
import { newPilotChatSession, type PilotChatSession } from "./pilotChatTypes";
import type { PilotBackendConfig } from "./pilotBackendTypes";
import type { WorkSession } from "./workHistory";
import { sessionPath } from "./workSessionIdentity";

/** Deterministic across restarts, distinct from user-created Pilot identities. */
export const migratedPilotId = (work: string): string => `pilot-${createHash("sha256").update(`legacy-work:${work}`).digest("hex").slice(0, 32)}`;

export function pilotFromWork(work: WorkSession, backend: PilotBackendConfig): PilotChatSession {
  const context = [...new Set([work.context.node, ...(work.context.nodes ?? []),
    ...(work.outputs ?? []).map(o => o.path), work.origin?.pilot].filter((p): p is string => !!p && p !== sessionPath(work.id)))];
  const s = newPilotChatSession(context, migratedPilotId(work.id), work.created);
  s.title = work.title;
  s.backend = { ...backend }; s.model = backend.model;
  s.legacyWork = { archiveStateMigrated: true, id: work.id, provider: work.provider, thread: work.thread, cwd: work.cwd, outputs: structuredClone(work.outputs ?? []) };
  s.messages = work.messages.filter(m => m.role !== "activity").map(m => ({
    ...structuredClone(m), role: m.role === "agent" ? "assistant" : "user",
  }));
  s.phase = work.status === "idle" ? "answered" : "interrupted";
  s.lifecycle = "dormant";
  s.deactivatedAt = work.archivedAt ?? work.worker?.archivedAt ?? work.external?.archivedAt;
  s.lastActivityAt = work.lastActivityAt ?? work.updated;
  s.updated = work.updated;
  // History already belongs to the old source. Only new turns get ingested.
  s.ingestedMessages = s.messages.length;
  return s;
}

/** Repair only untouched conversions: later activity may be an intentional reopen. */
export function repairMigratedArchive(s: PilotChatSession, work: WorkSession): void {
  if (!s.legacyWork || s.legacyWork.archiveStateMigrated) return;
  const archivedAt = work.archivedAt ?? work.worker?.archivedAt ?? work.external?.archivedAt;
  if (archivedAt && !s.deactivatedAt && s.updated === work.updated
    && s.lastActivityAt === (work.lastActivityAt ?? work.updated) && !s.turn
    && !s.draft.trim() && !s.draftImages?.length && !s.pendingInputs?.length
    && s.messages.length === work.messages.filter(m => m.role !== "activity").length) {
    s.deactivatedAt = archivedAt;
    s.lifecycle = "dormant";
  }
  s.legacyWork = { ...s.legacyWork, archiveStateMigrated: true };
}
