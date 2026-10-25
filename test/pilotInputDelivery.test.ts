import { expect, test } from "bun:test";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import { transitionPilot } from "../lib/pilotTransitions";
import { pilotChatDetail } from "../lib/pilotChatSummary";
import { acceptsPilotView, fullPilotView } from "../web/ui/src/lib/pilotChatSync";
const at = "2026-09-26T12:00:00Z";
test("a full view never yields to an older revision", () => {
  const s = newPilotChatSession([], undefined, at);
  s.inputs = [{ id: "stable", text: "hello", mode: "text", message: "envelope" }];
  s.messages = [{ id: "envelope", role: "user", text: "hello", at }, { id: "answer", role: "assistant", text: "Hi", at }];
  const detail = pilotChatDetail(s);
  expect(acceptsPilotView(fullPilotView(detail), { revision: detail.revision - 1 }, true)).toBe(false);
});
test("image queue survives interruption/restart; new text cannot overtake or resume it", () => {
  let s = newPilotChatSession([], undefined, at);
  const send = (id: string, images?: { id: string; name: string }[]) => { s = transitionPilot(s, { kind: "input", input: { id, text: id, mode: "text", images }, message: `message-${id}`, turn: `turn-${id}`, at, queue: true }).state; };
  send("first");
  send("image", [{ id: "image-fixture", name: "fabricated.png" }]);
  s = transitionPilot(s, { kind: "restart" }).state;
  send("text");
  expect(s.turn).toBeUndefined();
  expect(s.phase).toBe("interrupted");
  expect(s.pendingInputs?.map(i => i.id)).toEqual(["image", "text"]);
  expect(pilotChatDetail(s).pendingInputs?.map(i => i.id)).toEqual(["image", "text"]);
  // A caller that cannot queue is told why, not that Pilot is working.
  expect(() => transitionPilot(s, { kind: "input", input: { id: "direct", text: "direct", mode: "text" }, message: "message-direct", turn: "turn-direct", at, queue: false })).toThrow("Resume them first");
  s = transitionPilot(s, { kind: "resume", message: "resumed-image", turn: "resumed", at }).state;
  expect(s.inputs?.at(-1)?.id).toBe("image");
  expect(s.messages.at(-1)?.images?.[0]?.id).toBe("image-fixture");
  expect(s.pendingInputs?.map(i => i.id)).toEqual(["text"]);
});
