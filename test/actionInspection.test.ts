import { expect, test } from "bun:test";
import { actionReceiptView, type ActionReceipt } from "../lib/applicationActions";
import { actionOutcome } from "../web/ui/src/lib/actionHistoryView";
const receipt: ActionReceipt = { version: 1, id: "a".repeat(64), actor: { kind: "user", id: "desktop" }, request: "invented", operation: "source_set_unread", scope: [], fingerprint: "b".repeat(64), status: "completed", created: "2026-09-01T00:00:00Z", updated: "2026-09-01T00:00:00Z" };
test("public inspection retains per-item confirmation but excludes arbitrary provider results", () => {
  const result = { ok: false, secret: "PRIVATE_FIXTURE_TOKEN", results: [
    { path: "log/insertions/invented.json", title: "PRIVATE_FIXTURE_TITLE", ok: true, readState: { status: "synced", unread: false, password: "PRIVATE_FIXTURE_PASSWORD" } },
    { path: "https://unexpected.invalid", ok: false, readState: { status: "unavailable", unread: true }, error: "PRIVATE_FIXTURE_ERROR" },
  ] };
  const view = actionReceiptView({ ...receipt, result });
  expect(view.observations).toEqual([{ kind: "read-state", target: "log/insertions/invented.json", confirmed: true, unread: false }, { kind: "read-state", target: undefined, confirmed: false }]);
  expect(JSON.stringify(view)).not.toContain("PRIVATE_FIXTURE"); expect(actionOutcome(view).label).toBe("Partially confirmed");
  expect(actionReceiptView({ ...receipt, status: "uncertain", result }).observations).toEqual([]);
  expect(actionOutcome({ ...view, status: "uncertain", observations: [] }).label).toBe("Outcome unknown");
  expect(actionOutcome({ ...view, status: "failed" }).label).toBe("Not dispatched");
});
test("agent and contribution links accept only recognized result identities", () => {
  const agent = `work-${"a".repeat(32)}`;
  expect(actionReceiptView({ ...receipt, operation: "launch_agent", result: { id: agent, transcript: "private" } }).observations).toEqual([{ kind: "agent", target: agent, confirmed: true }]);
  expect(actionReceiptView({ ...receipt, operation: "launch_agent", result: { id: "https://unexpected.invalid" } }).observations).toEqual([]);
  expect(actionReceiptView({ ...receipt, operation: "drop", result: { path: "log/insertions/../../private" } }).observations).toEqual([]);
});
