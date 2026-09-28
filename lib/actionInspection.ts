import type { ActionReceipt } from "./applicationActions";
/** Public observations, never a serialization of a tool's arbitrary result. */
export interface ActionObservation {
  kind: "agent" | "contribution" | "read-state";
  target?: string;
  confirmed: boolean;
  unread?: boolean;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sourcePath = (value: unknown): string | undefined => typeof value === "string" && /^(log\/insertions\/|sources\/|source:)/.test(value) && !value.includes("..") ? value : undefined;
export function actionObservations(receipt: ActionReceipt): ActionObservation[] {
  if (receipt.status !== "completed") return [];
  const result = record(receipt.result);
  if (["launch_agent", "message_agent", "reply_agent"].includes(receipt.operation)) {
    const id = result.id ?? receipt.scope.find(id => /^work-[a-f0-9]{32}$/.test(id));
    return typeof id === "string" && /^work-[a-f0-9]{32}$/.test(id) ? [{ kind: "agent", target: id, confirmed: true }] : [];
  }
  if (["drop", "directive"].includes(receipt.operation)) {
    const path = sourcePath(result.path);
    return path ? [{ kind: "contribution", target: path, confirmed: true }] : [];
  }
  if (receipt.operation === "source_set_unread") {
    return (Array.isArray(result.results) ? result.results.slice(0, 100) : []).map(value => {
      const row = record(value), state = record(row.readState);
      const confirmed = row.ok === true && state.status === "synced" && typeof state.unread === "boolean";
      return { kind: "read-state", target: sourcePath(row.path), confirmed, ...(confirmed ? { unread: state.unread as boolean } : {}) };
    });
  }
  if (receipt.operation === "source_set_unread.item" || receipt.operation === "inbox_set_unread") {
    const confirmed = (result.status === "synced" || result.changed === true) && typeof result.unread === "boolean";
    return [{ kind: "read-state", target: receipt.operation === "source_set_unread.item" ? sourcePath(receipt.scope[0]) : undefined,
      confirmed, ...(confirmed ? { unread: result.unread as boolean } : {}) }];
  }
  return [];
}
