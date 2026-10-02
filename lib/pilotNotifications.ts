/** Stored with the Pilot session and its referenced message in one atomic write. */
export interface PilotNotification {
  id: string;
  pilotId: string;
  pilotTitle: string;
  messageId: string;
  key: string;
  text: string;
  kind: "question" | "update";
  at: string;
  seen: boolean;
  dismissed?: boolean;
  resolved?: boolean;
  workerRequest?: string;
}

/** A notification is a headline, not a report. Backtested on 213 historical notifications: rewritten ones peaked at 220 characters. */
export const NOTIFICATION_CHARS = 200;
export const NOTIFICATION_HARD_CHARS = 220;

/** These tools are installed only in the bound Pilot runtime, never worker/MCP tools. */
export const PILOT_NOTIFICATION_TOOLS = [
  { type: "function", name: "notify_user", strict: false,
    description: `Notify the user only for one of two reasons. kind=question: an action item — a decision, answer, approval or step only the user can take. kind=update: work the user asked for is substantively done (or has definitively failed), including the answer to a question they asked. Never notify for progress, intermediate findings, relayed answers, or reports that need nothing from the user; say those in your reply instead. The text IS the notification: at most ${NOTIFICATION_CHARS} characters, one or two plain sentences that lead with the ask or the outcome. No test counts, commit hashes, caveats or background; those belong in your reply. Creates a durable message in THIS Pilot conversation and an inbox notification. Use a stable key per distinct request/result; repeating the same key returns the existing notification. The tool posts this text in the conversation; avoid repeating it verbatim in your final response. Identity is supplied by the runtime.`,
    parameters: { type: "object", properties: { key: { type: "string" }, kind: { type: "string", enum: ["question", "update"] }, text: { type: "string", maxLength: NOTIFICATION_CHARS } }, required: ["key", "kind", "text"], additionalProperties: false } },
  { type: "function", name: "resolve_notification", strict: false,
    description: "Resolve an outstanding notification from THIS Pilot when its question has been answered in conversation or is no longer relevant. Use the exact notification ID from current context.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
];
