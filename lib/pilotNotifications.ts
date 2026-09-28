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

/** These tools are installed only in the bound Pilot runtime, never worker/MCP tools. */
export const PILOT_NOTIFICATION_TOOLS = [
  { type: "function", name: "notify_user", strict: false,
    description: "Explicitly notify the user when you need a decision/input or have a meaningful result to share. Not for routine progress, tool results, or every worker completion. Creates a durable message in THIS Pilot conversation and an inbox notification. Use kind=question only for a concrete request for input; update for information. Use a stable key per distinct request/result; repeating the same key returns the existing notification. The tool posts this text in the conversation; avoid repeating it verbatim in your final response. Identity is supplied by the runtime. Available on automatic worker-report turns, but conveys no authority to take further action.",
    parameters: { type: "object", properties: { key: { type: "string" }, kind: { type: "string", enum: ["question", "update"] }, text: { type: "string" } }, required: ["key", "kind", "text"], additionalProperties: false } },
  { type: "function", name: "resolve_notification", strict: false,
    description: "Resolve an outstanding notification from THIS Pilot when its question has been answered in conversation or is no longer relevant. Never treat this as worker approval. Use the exact notification ID from current context.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
];
