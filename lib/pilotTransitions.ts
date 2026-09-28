import { isEmptyPilotDraft, type PilotChatSession, type PilotChatMessage, type PilotInput, type PilotTurn } from "./pilotChatTypes";
import type { HistoricalWorkerReport } from "./workHistory";
import type { PilotNotification } from "./pilotNotifications";
import { PILOT_LIFECYCLE } from "./pilotLifecycleConfig";
import { pilotChatChapter } from "./pilotChatIngestion";

export class PilotTransitionError extends Error {
  readonly status = 409;
}
type Chapter = NonNullable<PilotChatSession["pendingIngestion"]>;
export type PilotEffect =
  | { kind: "start"; turn: PilotTurn }
  | { kind: "abort"; turn: string }
  | { kind: "release" | "advance" | "schedule-reports" | "discard" }
  | { kind: "publish"; id: string; chapter: Chapter; activity?: string };
export type PilotEvent =
  | { kind: "restart" }
  | { kind: "activity"; at: string }
  | { kind: "input"; input: PilotInput; message: string; turn: string; at: string; queue: boolean }
  | { kind: "resume"; message: string; turn: string; at: string }
  | { kind: "reports"; turn: string; at: string }
  | { kind: "worker-report"; report: HistoricalWorkerReport; notification?: PilotNotification }
  | { kind: "delta"; turn: string; text: string }
  | { kind: "message"; turn: string; message: PilotChatMessage }
  | { kind: "settled"; turn: string; outcome: "answered" | "interrupted" | "failed"; error?: string; at: string; advance: boolean }
  | { kind: "stop" | "deactivate"; at: string }
  | { kind: "notification"; id: string; action: "seen" | "unseen" | "dismiss" | "resolve" }
  | { kind: "notify"; notification: PilotNotification }
  | { kind: "age"; at: string; blocked: boolean }
  | { kind: "published"; chapter: Chapter; activity?: string; receipt: { id: string; insertionId: string; path: string } }
  | { kind: "publication-failed"; chapter: Chapter };

/** Pure application rules. IDs, time, authority checks and I/O are supplied by
 * the host. A stale turn or chapter completion is a no-op, never a new command. */
export function transitionPilot(current: PilotChatSession, event: PilotEvent): { state: PilotChatSession; effects: PilotEffect[] } {
  const unchanged = () => ({ state: current, effects: [] });
  if ("turn" in event && ["delta", "message", "settled"].includes(event.kind)
    && (current.turn?.id !== event.turn || event.kind !== "settled" && current.turn.status !== "running")) return unchanged();
  const s = { ...current };
  const effects: PilotEffect[] = [];
  const activity = (at: string) => { s.lastActivityAt = at; s.lifecycle = "active"; delete s.deactivatedAt; };
  const begin = (turn: PilotTurn) => {
    s.turn = turn; s.live = ""; s.activity = ""; s.error = ""; s.phase = "working";
    effects.push({ kind: "start", turn });
  };
  const accept = (input: PilotInput, message: string, turn: string, at: string) => {
    activity(at);
    s.messages = [...s.messages, { id: message, role: "user", text: input.text, at, ...(input.images?.length ? { images: input.images } : {}) }];
    s.inputs = [...(s.inputs ?? []), { ...input, message }];
    begin({ id: turn, status: "running", replyTo: message });
  };
  const acknowledge = (input: PilotInput) => {
    s.notifications = s.notifications?.map(n => ({ ...n, seen: true, resolved: n.workerRequest ? n.resolved : true }));
    if (s.draft.trim() === input.text) s.draft = "";
    s.draftImages = (s.draftImages ?? []).filter(image => !input.images?.some(sent => sent.id === image.id));
  };
  switch (event.kind) {
    case "restart":
      s.lastActivityAt ??= s.updated; s.lifecycle ??= "active";
      if (s.turn || s.phase === "working") {
        delete s.turn; s.phase = "interrupted"; s.activity = "";
        s.error = "Pilot stopped when the engine restarted. Send a message to continue.";
      }
      break;
    case "activity": activity(event.at); break;
    case "input": {
      const prior = s.inputs?.find(i => i.id === event.input.id) ?? s.pendingInputs?.find(i => i.id === event.input.id);
      if (prior) {
        const a = event.input;
        // Text and voice can retry the same logical input through either door.
        if (prior.text !== a.text || prior.target !== a.target || prior.notificationId !== a.notificationId
          || JSON.stringify(prior.images ?? []) !== JSON.stringify(a.images ?? [])) throw new PilotTransitionError("That input ID already belongs to a different message.");
        return unchanged();
      }
      if (s.turn?.status === "stopping") throw new PilotTransitionError("Pilot is stopping. Wait before resuming it.");
      if (event.input.notificationId !== undefined && !s.notifications?.some(n => n.id === event.input.notificationId && n.kind === "question" && !n.resolved))
        throw new PilotTransitionError("This question is no longer awaiting an answer. Refresh the conversation.");
      if (s.turn || s.pendingInputs?.length) {
        if (!event.queue) throw new PilotTransitionError("Pilot is already working in this session.");
        if ((s.pendingInputs?.length ?? 0) >= 8) throw new PilotTransitionError("Wait for Pilot to process the queued messages.");
        s.pendingInputs = [...(s.pendingInputs ?? []), event.input];
        // Appending is not permission to resume an explicitly stopped queue.
        if (s.turn) activity(event.at);
      } else accept(event.input, event.message, event.turn, event.at);
      acknowledge(event.input);
      break;
    }
    case "resume": {
      if (s.turn) throw new PilotTransitionError("Pilot is still working.");
      const next = s.pendingInputs?.[0];
      if (!next) return unchanged();
      s.pendingInputs = s.pendingInputs!.slice(1);
      accept(next, event.message, event.turn, event.at);
      break;
    }
    case "reports":
      if (s.turn || s.deactivatedAt || s.phase === "interrupted" || s.phase === "failed" || s.pendingInputs?.length || !s.pendingAgentSessionReports?.length) return unchanged();
      begin({ id: event.turn, status: "running", reports: [...s.pendingAgentSessionReports] });
      break;
    case "worker-report":
      if (s.workEvents?.some(r => r.key === event.report.key)) return unchanged();
      s.workEvents = [...(s.workEvents ?? []), event.report];
      if (event.notification) {
        const n = event.notification;
        s.messages = [...s.messages, { id: n.messageId, role: "assistant", text: n.text, at: n.at }];
        s.notifications = [...(s.notifications ?? []), n];
      } else {
        s.pendingAgentSessionReports = [...(s.pendingAgentSessionReports ?? []), event.report.key];
        if (!s.deactivatedAt) effects.push({ kind: "schedule-reports" });
      }
      break;
    case "delta": s.live += event.text; break;
    case "message":
      if (s.messages.some(m => m.id === event.message.id)) return unchanged();
      s.messages = [...s.messages, event.message]; s.live = "";
      break;
    case "settled": {
      const turn = s.turn!;
      const stopped = turn.status === "stopping" || !!s.deactivatedAt;
      s.phase = stopped ? "interrupted" : event.outcome; s.activity = "";
      s.error = s.phase === "failed" ? event.error ?? "Pilot could not complete the request." : "";
      if (s.phase === "answered") {
        s.live = "";
        s.pendingAgentSessionReports = s.pendingAgentSessionReports?.filter(key => !turn.reports?.includes(key));
      }
      if (!s.deactivatedAt) activity(event.at);
      delete s.turn;
      if (s.deactivatedAt) effects.push({ kind: "release" });
      else if (s.phase === "answered" && event.advance) effects.push({ kind: "advance" });
      break;
    }
    case "stop":
    case "deactivate":
      if (s.turn) { s.turn = { ...s.turn, status: "stopping" }; effects.push({ kind: "abort", turn: s.turn.id }); }
      if (s.phase === "working") { s.phase = "interrupted"; s.activity = ""; if (!s.deactivatedAt) activity(event.at); }
      if (event.kind === "deactivate") {
        s.lifecycle = "dormant"; s.deactivatedAt = event.at; s.composerLeaseUntil = 0;
        if (!s.turn) effects.push({ kind: "release" });
      }
      break;
    case "notification": {
      const n = s.notifications?.find(n => n.id === event.id);
      if (!n) throw new PilotTransitionError("Notification not found.");
      const index = s.messages.findIndex(m => m.id === n.messageId);
      if (event.action === "unseen" && (n.resolved || !n.workerRequest && index >= 0 && s.messages.slice(index + 1).some(m => m.role === "user")))
        throw new PilotTransitionError("This notification already has a subsequent turn.");
      s.notifications = s.notifications!.map(n => n.id !== event.id ? n : { ...n,
        ...(event.action === "seen" ? { seen: true } : event.action === "unseen" ? { seen: false, dismissed: false } : event.action === "dismiss" ? { dismissed: true } : { resolved: true }) });
      break;
    }
    case "notify": {
      const n = event.notification;
      if (s.notifications?.some(prior => prior.key === n.key)) return unchanged();
      s.notifications = [...(s.notifications ?? []), n];
      s.messages = [...s.messages, { id: n.messageId, role: "assistant", text: n.text, at: n.at }];
      break;
    }
    case "age": {
      const now = Date.parse(event.at), idle = now - Date.parse(s.lastActivityAt ?? s.updated);
      if (event.blocked || s.turn) return unchanged();
      if (isEmptyPilotDraft(s) && (s.composerLeaseUntil ?? 0) <= now && idle >= PILOT_LIFECYCLE.abandonedDraftAfterMs) {
        effects.push({ kind: "discard" }); break;
      }
      if (s.phase === "working" || s.phase === "draft" || s.draft.trim() || s.draftImages?.length) return unchanged();
      if (idle >= PILOT_LIFECYCLE.dormantAfterMs && s.lifecycle === "active") { s.lifecycle = "dormant"; effects.push({ kind: "release" }); }
      if ((s.composerLeaseUntil ?? 0) > now || idle < PILOT_LIFECYCLE.ingestAfterMs || !s.messages.length) break;
      if ((s.ingestedMessages ?? 0) < s.messages.length) {
        s.pendingIngestion ??= pilotChatChapter(s, event.at);
        effects.push({ kind: "publish", id: `${s.id}:chapter:${s.pendingIngestion.through}`, chapter: s.pendingIngestion, activity: s.lastActivityAt });
      } else if (s.lifecycle === "dormant") s.lifecycle = "ingested";
      break;
    }
    case "published":
    case "publication-failed":
      if (!s.pendingIngestion || s.pendingIngestion.through !== event.chapter.through || s.pendingIngestion.content !== event.chapter.content) return unchanged();
      if (event.kind === "publication-failed") s.ingestionError = "Pilot transcript could not be ingested. It is saved locally and will retry automatically.";
      else {
        s.ingestions = [...(s.ingestions ?? []), { through: event.chapter.through, sourceId: event.receipt.id, insertionId: event.receipt.insertionId, path: event.receipt.path }];
        s.ingestedMessages = event.chapter.through; delete s.pendingIngestion; delete s.ingestionError;
        if (s.lastActivityAt === event.activity && s.lifecycle === "dormant" && s.ingestedMessages === s.messages.length && !s.turn) s.lifecycle = "ingested";
      }
      break;
  }
  const same = Object.keys(current).length === Object.keys(s).length && (Object.keys(s) as (keyof PilotChatSession)[]).every(key => s[key] === current[key]);
  return { state: same ? current : s, effects };
}
