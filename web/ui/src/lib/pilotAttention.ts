import { lastMessageAt } from "../../../../lib/messageTime";
import { isActivePilot } from "./pilotActivity";
import { ARCHIVED_STATUS, pilotStatusView, pilotVisualPhase, type PilotStatusView } from "./pilotAppearance";
import { agentStatusView } from "./agentAppearance";
import { parseMentions, mentionText } from "../../../../lib/pilotMentions";
import { pilotMessageCount } from "../../../../lib/pilotChatSummary";
import { bySessionOrder } from "./sessionOrder";
import type { PilotViewData } from "./pilotChatSync";
import type { PilotNotification } from '../../../../lib/pilotNotifications';

export interface PilotRequest { id: string; text: string; notification?: PilotNotification }
export interface PilotRosterEntry {
  lastMessageAt?: string;
  archived?: boolean; agentState?: import('./agentAppearance').AgentVisualState;
  id: string; title: string; model: string;
  phase?: import("./pilotAppearance").PilotVisualPhase;
  state: 'waiting' | 'running' | 'idle'; requests: PilotRequest[]; preview?: string; unread?: boolean;
}
/** Request identity survives browsing. Seen/dismissed are legacy presentation
 * flags, not evidence that a question has been answered. */

export function pilotRoster(sessions: PilotViewData[], includeArchived = false): PilotRosterEntry[] {
  // Keep the roster in creation order even when activity reorders the source.
  return [...sessions].sort(bySessionOrder).flatMap<PilotRosterEntry>(s => {
    // Explicitly closed sessions keep their history, not an active request badge.
    if (!isActivePilot(s)) return includeArchived ? [{ id:s.id, lastMessageAt:lastMessageAt(s), title:s.title, model:s.backend?.model ?? s.model,
      archived:true, phase:'idle' as const, state:'idle' as const, requests:[], unread:false }] : [];
    const answered = new Set([...(s.inputs ?? []), ...(s.pendingInputs ?? [])].map(i => i.notificationId));
    const requests: PilotRequest[] = (s.notifications ?? [])
      .filter(n => n.kind === 'question' && !n.resolved && !answered.has(n.id))
      .map(n => ({ id: n.id, text: n.text, notification: n }));
    const running = s.phase === 'working';
    if (!includeArchived && !requests.length && !running && s.phase === 'draft' && !pilotMessageCount(s) && !s.draft.trim() && !s.draftImages?.length) return [];
    // Only a genuine draft shows its unsent text in place of a title: a record
    // whose phase its own history contradicts keeps the title it was given.
    const phase = requests.length ? 'active' as const : pilotVisualPhase(s);
    const draft = phase === 'draft' ? mentionText(parseMentions(s.draft)).replace(/\s+/g, ' ').trim() : '';
    const title = draft ? draft.slice(0, 64).trimEnd() + '…' : s.title;
    return [{ id: s.id, lastMessageAt: lastMessageAt(s), title, phase, model: s.backend?.model ?? s.model, state: requests.length ? 'waiting' : running ? 'running' : 'idle', requests, unread: requests.some(r => !r.notification || !r.notification.seen && !r.notification.dismissed) || (s.notifications ?? []).some(n => !n.seen && !n.dismissed && !n.resolved && !answered.has(n.id)), preview: requests[0]?.text ?? s.notifications?.filter(n => !n.resolved && !n.dismissed).at(-1)?.text }];
  });
}

/** One status word per roster row, whatever kind of agent it holds: the sidebar
 *  list, the workspace menu and the row's accessible name read the same source,
 *  so a stopped or failed turn can never be announced as "Ready". */
export const rosterStatusView = (p: Pick<PilotRosterEntry, "phase" | "state" | "archived" | "agentState">): PilotStatusView =>
  p.archived ? ARCHIVED_STATUS : p.agentState ? agentStatusView(p.agentState) : pilotStatusView(p.phase, { state: p.state });

/** Hide discarded empty drafts from history without deleting their records. */
export function isStoppedEmptyPilot(s: PilotViewData & { hasHistory?: boolean }, draft = s.draft): boolean {
  return !!s.deactivatedAt && !s.hasHistory && !draft.trim() && !s.draftImages?.length && !pilotMessageCount(s)
    && !s.live.trim() && !s.inputs?.length && !s.pendingInputs?.length
    && !s.ingestions?.length;
}
