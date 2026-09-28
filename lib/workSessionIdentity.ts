import type { WorkSummary } from "./workHistory";

export const sessionPath = (id: string): string => `sessions/${id}.md`;
interface SourceIdentity { path?: string | null; sessionId?: string; from?: string; via?: string }
/** Provider IDs belong to a provider; a same-spelled ID from another agent
 * must never inherit control or pending requests. */
export function belongsToSession(source: SourceIdentity, session: Pick<WorkSummary, "id" | "thread" | "provider">): boolean {
  if (source.path === sessionPath(session.id)) return true;
  if (!session.thread || source.sessionId !== session.thread) return false;
  const provider = (source.from ?? source.via ?? "").toLowerCase().replace(/[_ ]/g, "-");
  return provider === session.provider || (session.provider === "claude-code" && provider === "claude");
}
