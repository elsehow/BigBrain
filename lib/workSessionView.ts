/** Render archived worker conversations as ordinary source notes. */
import type { WorkSession } from "./workHistory";
export { sessionPath } from "./workSessionIdentity";

export function sessionMarkdown(session: WorkSession): string {
  return `---\ntitle: ${JSON.stringify(session.title)}\ntype: source\nfrom: ${session.provider}\n---\n\n` +
    session.messages.filter(m => m.role !== "activity").map(m => `### ${m.role === "user" ? "You" : session.provider}\n\n${m.text}`).join("\n\n");
}
