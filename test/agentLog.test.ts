import { expect, test } from "bun:test";
import { nativeAgentEvidence, logWindow, parseAgentLog, goalLogInput } from "../lib/agentLog";
test("Quick evidence excludes reasoning, injected memory, sidechains and unrelated vault contents", () => {
  const rows = [
    { type: "user", timestamp: "1", message: { content: "Injected personal memory" } },
    { type: "assistant", timestamp: "2", message: { content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "Running tests." }, { type: "tool_use", id: "tool", name: "Bash", input: { description: "Run test suite", command: "DO NOT EXECUTE" } }, { type: "tool_use", id: "memory", name: "mcp__bigbrain_current__load_memory", input: { topic: "project" } }] } },
    { type: "user", timestamp: "3", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "2 tests failed", is_error: true }, { type: "tool_result", tool_use_id: "memory", content: "unrelated personal data" }] } },
    { type: "assistant", timestamp: "4", isSidechain: true, message: { content: [{ type: "text", text: "sidechain content" }] } },
  ];
  const evidence = nativeAgentEvidence(rows), text = JSON.stringify(evidence);
  expect(evidence).toHaveLength(4); expect(text).toContain("2 tests failed");
  expect(evidence.at(-1)?.text).toContain("result for Run test suite");
  expect(evidence.at(-1)?.text).toContain("partial success");
  for (const excluded of ["private reasoning", "personal", "DO NOT EXECUTE", "sidechain content"]) expect(text).not.toContain(excluded);
});
test("reported shell errors preserve partial success without declaring the task blocked", () => {
  const evidence = nativeAgentEvidence([
    { type: "assistant", timestamp: "1", message: { content: [{ type: "tool_use", id: "worktree", name: "Bash", input: { description: "Create worktree" } }] } },
    { type: "user", timestamp: "2", message: { content: [{ type: "tool_result", tool_use_id: "worktree", is_error: true, content: "Preparing worktree\nHEAD is now at abc123\noperation not permitted: /tmp/cwd" }] } },
  ]);
  expect(evidence[1].text).toContain("HEAD is now at abc123");
  expect(evidence[1].text).toContain("result for Create worktree");
  expect(evidence[1].text).not.toContain("FAILED");
});
test("Quick replay windows exclude future events and validate citations", () => {
  const events = [{ id: "a", at: "1", kind: "message" as const, text: "Starting tests" }, { id: "b", at: "3", kind: "tool-result" as const, text: "Tests passed" }];
  const window = logWindow(events, "0", "2"); expect(window.map(e => e.id)).toEqual(["a"]);
  expect(parseAgentLog('{"text":"Running the test suite.","evidence":["a"]}', window).text).toBe("Running the test suite.");
  expect(() => parseAgentLog('{"text":"Tests passed.","evidence":["b"]}', window)).toThrow("unavailable");
  expect(parseAgentLog('{"text":null,"evidence":[]}', window).text).toBeNull();
});
test("both goal strategies retain the exact Pilot goal and prior updates", () => {
  const goal = "Add extinction probabilities. Compare wording; do not assume agreement.";
  const previous = [{ id: "u1", at: "2", text: "Reading the questions.", evidence: ["a"] }];
  const evidence = [{ id: "a", at: "1", kind: "message" as const, text: "Reading" }, { id: "b", at: "3", kind: "message" as const, text: "Writing" }, { id: "future", at: "5", kind: "message" as const, text: "Done" }];
  const full = goalLogInput({ goal, previous, evidence, created: "0", through: "4", mode: "full" });
  const delta = goalLogInput({ goal, previous, evidence, created: "0", through: "4", mode: "delta" });
  for (const input of [full, delta]) {
    expect(input.pilot_goal).toBe(goal);
    expect(input.previous_updates).toEqual(previous);
    expect(input.instruction).toContain("with respect to the specified Pilot goal");
    expect(input.evidence.some(e => e.id === "future")).toBe(false);
  }
  expect(full.evidence.map(e => e.id)).toEqual(["a", "b"]);
  expect(delta.evidence.map(e => e.id)).toEqual(["b"]);
});
test("no published update means accumulated evidence is retained for the next attempt", () => {
  const args = { goal: "Ship a change", previous: [], evidence: [{ id: "a", at: "1", kind: "message" as const, text: "Reading" }, { id: "b", at: "3", kind: "message" as const, text: "Writing" }], created: "0", mode: "delta" as const };
  const first = goalLogInput({ ...args, through: "2" });
  expect(parseAgentLog('{"text":null,"evidence":[]}', first.evidence).text).toBeNull();
  const next = goalLogInput({ ...args, through: "4" });
  expect(next.evidence_since).toBe("0");
  expect(next.evidence.map(e => e.id)).toEqual(["a", "b"]);
  expect(() => goalLogInput({ ...args, goal: "", through: "4" })).toThrow("Pilot goal");
});
test("full-history comparison does not silently apply the old window budget", () => {
  const evidence = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, at: "1", kind: "tool-result" as const, text: "x".repeat(1000) }));
  const input = goalLogInput({ goal: "Pilot's entire goal", previous: [], evidence, created: "0", through: "2", mode: "full" });
  expect(input.evidence).toHaveLength(40);
});
