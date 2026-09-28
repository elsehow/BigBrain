import type { WorkSession } from "../../../../lib/workHistory";
import type { GraphData } from "../lib/types";

export const AGENT_CHAT_SCENES: Record<string, { label: string; note: string }> = {
  "quick-log": { label: "Quick · synthesized log", note: "Invented export task with target and imperfect summaries. Replay is local, with no model calls or real worker actions." },
  "quick-goal-delta": { label: "Quick · goal + diff", note: "Six invented incremental summaries, including a deliberate unsupported release claim. Compare with the source log; no live model calls." },
  "quick-goal-full": { label: "Quick · goal + whole", note: "Six invented summaries with repetition, a definition error, and premature success claims. Compare with the source log; no live model calls." },
  "quick-summarizing": { label: "Quick · summarizing", note: "A frozen checkpoint while Quick prepares the next entry. The little square spinner belongs to the summarizer, independently of the agent's working status." },
  "pilot-stop": { label: "Pilot stop confirmation", note: "Real Pilot header with a agent session. Shift-Esc warns; a second press stops both. Esc dismisses to graph. No real work is stopped." },
  running: { label: "Running", note: "Production agent chat and graph. Dots flow from Pilot to agent. Send a correction, stop, or simulate completion. All actions are local." },
  starting: { label: "Starting", note: "Accepted task, before the provider reports activity." },
  question: { label: "Needs an answer", note: "A worker question with suggested answers. Answering resumes this same agent." },
  approval: { label: "Needs permission", note: "Inspect the requested command, then allow or decline. No real permission is changed." },
  done: { label: "Turn finished", note: "The active-red square persists, with an output receipt and a follow-up composer." },
  stopped: { label: "Stopped", note: "The square settles into ink; history and context remain. A follow-up resumes the simulated agent." },
  failed: { label: "Failed", note: "A provider failure preserves the conversation and shows an explicit error." },
  terminal: { label: "In terminal", note: "External terminal ownership. App messages are refused until ownership returns." },
  long: { label: "Long conversation", note: "Overflow, lengthy activity, multiple turns, and inline context above the scrollable transcript. Try narrow widths and dark mode." },
  disconnected: { label: "Connection lost", note: "The initial history loads, then polling fails. Reconnect restores the same simulated agent." },
};
export const AGENT_CHAT_ID = `work-${"a".repeat(32)}`;
export const AGENT_PILOT_ID = `pilot-${"b".repeat(32)}`;
export const AGENT_CHAT_GRAPH: GraphData = {
  hash: "agent-chat-workbench",
  nodes: [
    { id: "memory/dana", path: "memory/dana", title: "Dana Reed", group: "entity", degree: 3, x: -120, y: 50 },
    { id: "memory/arbor", path: "memory/arbor", title: "Arbor OS", group: "memory", degree: 1, x: 110, y: -100 },
    { id: "memory/air", path: "memory/air", title: "Arbor Cloud", group: "memory", degree: 1, x: -180, y: -100 },
  ],
  edges: [{ source: "memory/dana", target: "memory/arbor" }, { source: "memory/dana", target: "memory/air" }],
};
export function agentChatFixture(scene: string, now = Date.now()): WorkSession {
  const created = new Date(now - 151_000).toISOString(), updated = new Date(now).toISOString();
  const session: WorkSession = {
    id: AGENT_CHAT_ID, title: "Arbor summary", provider: "claude-code", model: "Opus", cwd: "/demo/arbor", thread: "demo-thread",
    origin: { pilot: AGENT_PILOT_ID, message: "demo-launch" }, status: "working", created, updated, receipts: [],
    context: { nodes: AGENT_CHAT_GRAPH.nodes.map(n => n.id), title: "Dana × Arbor" },
    messages: [
      { id: "task", role: "user", at: created, text: "Summarize the Arbor research thread into one vault note. Link the people and projects involved, and flag anything uncertain." },
      { id: "read", role: "activity", at: created, text: "Read Arbor OS — research thread.md\nRead Arbor Cloud — call notes.md\nRead 4 more sources" },
      { id: "progress", role: "agent", at: updated, text: "I found the Arbor OS discussion and the Arbor Cloud call. I’m checking which people are directly involved before writing the summary." },
    ],
  };
  if (scene === "starting") { session.status = "starting"; session.messages.splice(1); }
  if (scene === "question" || scene === "approval") {
    session.status = "needs-input";
    session.pending = scene === "question"
      ? { id: "question", key: "demo-question", method: "item/tool/requestUserInput", params: { questions: [{ id: "scope", question: "Include adjacent collaborators, or only people directly involved in Arbor?", options: [{ label: "Direct involvement only" }, { label: "Include adjacent collaborators" }] }] } }
      : { id: "approval", key: "demo-approval", method: "item/commandExecution/requestApproval", params: { reason: "Allow the agent to run the project’s link validator?", command: "bun run validate-links" } };
  }
  if (scene === "done") finishAgentFixture(session);
  if (scene === "stopped") session.status = "interrupted";
  if (scene === "terminal") session.status = "terminal";
  if (scene === "failed") { session.status = "failed"; session.error = "The provider connection closed before this turn completed. No output was submitted."; }
  if (scene === "long") for (let i = 0; i < 18; i++) session.messages.push({ id: `long-${i}`, role: i % 3 === 0 ? "user" : i % 3 === 1 ? "activity" : "agent", at: updated,
    text: i % 3 === 0 ? "Check the attribution against the original thread, and keep uncertain connections separate."
      : i % 3 === 1 ? `Reading source ${i + 1}: research/compartmentalization-and-sandboxing/meeting-notes-and-follow-up-questions.md`
      : "The source supports the project connection, but not direct authorship. I’ll preserve that distinction in the note and cite the original discussion.\n\nThe remaining question is whether the call notes describe an implementation plan or an exploratory idea." });
  return session;
}
export function finishAgentFixture(session: WorkSession): void {
  session.status = "idle"; delete session.pending; delete session.error;
  session.updated = new Date().toISOString();
  session.outputs = [{ id: "demo-output", path: "source/arbor-summary.md", title: "Arbor research — summary", kind: "vault", status: "submitted", at: session.updated }];
  session.messages.push({ id: `done-${session.messages.length}`, role: "agent", at: session.updated,
    text: "Submitted Arbor research — summary to the vault. It covers Arbor OS and Arbor Cloud, with source references. Filing and graph updates are still pending." });
}
