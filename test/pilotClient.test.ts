import { PilotResponseGate } from "../web/ui/src/lib/pilot";
/** pilotClient.test.ts — the pilot page's pure decisions (#770,
 * web/ui/src/lib/pilot.ts): which key talks, what each server event means,
 * where the screen goes on a tool call, tap vs hold. */
import { describe, expect, test } from "bun:test";
import {
  isQuietError,
  isTalkKey,
  isTap,
  MIN_HOLD_MS,
  navigationFor,
  phaseLabel,
  reduceEvent,
  TALKS_WHEN_EMPTY,
  type KeyLike,
} from "../web/ui/src/lib/pilot";

const key = (over: Partial<KeyLike> = {}): KeyLike => ({
  code: "Space",
  repeat: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  target: null,
  ...over,
});

const field = (tagName: string, value = "", attrs: Record<string, string> = {}) =>
  ({ tagName, value, getAttribute: (n: string) => attrs[n] ?? null }) as unknown as EventTarget;

describe("the talk key", () => {
  test("bare SPACE outside a text field, first press only", () => {
    expect(isTalkKey(key())).toBe(true);
    expect(isTalkKey(key({ target: field("DIV") }))).toBe(true);
    expect(isTalkKey(key({ repeat: true }))).toBe(false);
    expect(isTalkKey(key({ code: "Enter" }))).toBe(false);
    for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const)
      expect(isTalkKey(key({ [mod]: true }))).toBe(false);
  });

  test("a text field keeps its space — unless it opts in and is empty", () => {
    expect(isTalkKey(key({ target: field("INPUT") }))).toBe(false);
    expect(isTalkKey(key({ target: field("TEXTAREA") }))).toBe(false);
    expect(isTalkKey(key({ target: { isContentEditable: true } as unknown as EventTarget }))).toBe(false);
    expect(isTalkKey(key({ target: field("INPUT", "", { [TALKS_WHEN_EMPTY]: "" }) }))).toBe(true);
    expect(isTalkKey(key({ target: field("INPUT", "   ", { [TALKS_WHEN_EMPTY]: "" }) }))).toBe(true);
    expect(isTalkKey(key({ target: field("INPUT", "ridgeways", { [TALKS_WHEN_EMPTY]: "" }) }))).toBe(false);
  });

  test("microphone settings keep native keyboard controls; the talk button opts in", () => {
    expect(isTalkKey(key({ target: field("SELECT") }))).toBe(false);
    expect(isTalkKey(key({ target: field("OPTION") }))).toBe(false);
    expect(isTalkKey(key({ target: field("BUTTON") }))).toBe(false);
    expect(isTalkKey(key({ target: field("BUTTON", "", { [TALKS_WHEN_EMPTY]: "" }) }))).toBe(true);
  });
});

describe("the event reducer", () => {
  test("the person's words, the pilot's words, streamed and settled", () => {
    expect(reduceEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: " anything new? " })).toEqual({
      kind: "user-said",
      text: "anything new?",
    });
    expect(reduceEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "" })).toEqual({ kind: "none" });
    expect(reduceEvent({ type: "response.output_audio_transcript.delta", delta: "Two " })).toEqual({ kind: "pilot-delta", delta: "Two " });
    expect(reduceEvent({ type: "response.output_audio_transcript.done", transcript: "Two things landed." })).toEqual({
      kind: "pilot-said",
      text: "Two things landed.",
    });
    expect(reduceEvent({ type: "response.output_text.done", text: "typed" })).toEqual({ kind: "pilot-said", text: "typed" });
  });

  test("a function call carries its id, name and parsed arguments; bad JSON becomes empty args", () => {
    expect(
      reduceEvent({ type: "response.function_call_arguments.done", call_id: "c1", name: "search_vault", arguments: '{"query":"ridgeways"}' })
    ).toEqual({ kind: "call", callId: "c1", name: "search_vault", args: { query: "ridgeways" } });
    expect(reduceEvent({ type: "response.function_call_arguments.done", call_id: "c2", name: "recent", arguments: "{oops" })).toEqual({
      kind: "call",
      callId: "c2",
      name: "recent",
      args: {},
    });
    expect(reduceEvent({ type: "response.function_call_arguments.done", name: "recent" })).toEqual({ kind: "none" });
  });

  test("response.done says whether the turn is still going (calls pending) or settled", () => {
    expect(reduceEvent({ type: "response.done", response: { output: [{ type: "function_call" }] } })).toEqual({ kind: "response-done", hadCalls: true });
    expect(reduceEvent({ type: "response.done", response: { output: [{ type: "message" }] } })).toEqual({ kind: "response-done", hadCalls: false });
    expect(reduceEvent({ type: "response.done" })).toEqual({ kind: "response-done", hadCalls: false });
  });

  test("the output audio buffer's start and stop are the speaking phase; errors carry their message; the unknown is nothing", () => {
    expect(reduceEvent({ type: "output_audio_buffer.started" })).toEqual({ kind: "speaking", on: true });
    expect(reduceEvent({ type: "output_audio_buffer.stopped" })).toEqual({ kind: "speaking", on: false });
    expect(reduceEvent({ type: "output_audio_buffer.cleared" })).toEqual({ kind: "speaking", on: false });
    expect(reduceEvent({ type: "error", error: { message: "Incorrect API key" } })).toEqual({ kind: "error", message: "Incorrect API key" });
    expect(reduceEvent({ type: "error", error: { code: "server_error" } })).toEqual({ kind: "error", message: "server_error" });
    expect(reduceEvent({ type: "error" })).toEqual({ kind: "error", message: "the session reported an error" });
    expect(reduceEvent({ type: "rate_limits.updated" })).toEqual({ kind: "none" });
    expect(reduceEvent({ type: "some.future.event", payload: 1 })).toEqual({ kind: "none" });
  });

  test("an empty commit is a quiet error; anything else speaks", () => {
    expect(isQuietError("Error committing input audio buffer: buffer too small.")).toBe(true);
    expect(isQuietError("input_audio_buffer_commit_empty: buffer is empty")).toBe(true);
    expect(isQuietError("Incorrect API key provided")).toBe(false);
  });
});

describe("the screen follows the pilot", () => {
  test("reading opens, searching shows the hits, nothing else moves", () => {
    expect(navigationFor("read_note", { path: "memory/ridgeways.md" })).toEqual({ note: "memory/ridgeways.md" });
    expect(navigationFor("read_note", { path: "  " })).toBeNull();
    expect(navigationFor("search_vault", { query: "ridgeways" })).toEqual({ search: "ridgeways" });
    expect(navigationFor("recent", { limit: 5 })).toBeNull();
    expect(navigationFor("drop", { title: "x", body: "y" })).toBeNull();
  });
});

describe("tap vs hold, and the state line", () => {
  test("a release under the threshold is a tap", () => {
    expect(isTap(MIN_HOLD_MS - 1)).toBe(true);
    expect(isTap(MIN_HOLD_MS)).toBe(false);
  });
  test("every phase has its line; held reads as listening", () => {
    expect(phaseLabel("idle", false)).toBe("hold space to talk");
    expect(phaseLabel("ready", true)).toBe("listening");
    expect(phaseLabel("speaking", false)).toMatch(/interrupts/);
    expect(phaseLabel("off", false)).toBe("");
    expect(phaseLabel("error", false)).toBe("");
  });
});


test("Escape and barge-in reject late response audio and function calls, while the next turn stays usable", () => {
  const gate = new PilotResponseGate();
  const first = gate.next();
  expect(gate.accept({ type: "response.created", response: { id: "r1", metadata: { pilot_generation: String(first) } } })).toBe(true);
  expect(gate.accept({ type: "response.function_call_arguments.done", response_id: "r1" })).toBe(true);
  gate.next(); // Stop, before the tool promise or queued audio finishes.
  expect(gate.current(first)).toBe(false);
  expect(gate.accept({ type: "response.function_call_arguments.done", response_id: "r1" })).toBe(false);
  expect(gate.accept({ type: "output_audio_buffer.started", response_id: "r1" })).toBe(false);
  expect(gate.accept({ type: "response.done", response: { id: "r1" } })).toBe(false);
  const next = gate.next();
  expect(gate.accept({ type: "response.created", response: { id: "r2", metadata: { pilot_generation: String(next) } } })).toBe(true);
  expect(gate.accept({ type: "response.output_audio_transcript.delta", response_id: "r2", delta: "Hello" })).toBe(true);
  expect(gate.accept({ type: "conversation.item.input_audio_transcription.completed", item_id: "user1", transcript: "my words" })).toBe(true);
});
