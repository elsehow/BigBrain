// pilot.ts — the PURE decisions of the pilot's client (#770): which key is
// push-to-talk, what one server event means, where the screen goes when a
// tool is called, and when a hold was only a tap. The wire, the mic and the
// store live in ./pilot.svelte.ts; this file has no DOM and no window, so
// test/pilotClient.test.ts can pin the rules.

/** Every phase the HUD can show. `off` = no key set (the HUD is not
 * mounted); `idle` = a key, no session yet — the first hold connects. */
export type Phase = "off" | "idle" | "connecting" | "ready" | "listening" | "thinking" | "speaking" | "error";

/** A release before this is a tap, not a turn: the buffer is cleared, not
 * committed — a committed sliver errors as too short and costs a round trip
 * to say so. Long enough to miss an accidental tap, short enough that "hm?"
 * still lands. */
export const MIN_HOLD_MS = 250;

/** A session nobody has held the key in for this long is closed (and its
 * conversation settled); the next hold opens a new one. */
export const IDLE_DISCONNECT_MS = 10 * 60_000;

/** The palette's query field opts in with this attribute: SPACE in an EMPTY
 * field talks (a leading space is not a query); once typed into, it types. */
export const TALKS_WHEN_EMPTY = "data-talks-when-empty";

export interface KeyLike {
  code: string;
  repeat?: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}

interface FieldLike {
  tagName?: string;
  isContentEditable?: boolean;
  value?: string;
  getAttribute?: (name: string) => string | null;
}

/** Is this keydown the push-to-talk press? Bare SPACE, not auto-repeat, not
 * in a text field — except a field that opts in (TALKS_WHEN_EMPTY) while it
 * is empty. */
export function isTalkKey(e: KeyLike): boolean {
  if (e.code !== "Space" || e.repeat) return false;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  const el = e.target as FieldLike | null;
  if (!el) return true;
  if (el.tagName === "SELECT" || el.tagName === "OPTION") return false;
  const field = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON" || !!el.isContentEditable;
  if (!field) return true;
  const optsIn = el.getAttribute?.(TALKS_WHEN_EMPTY) != null;
  return optsIn && !(el.value ?? "").trim();
}

/** One server event off the data channel — `type` and whatever rides with it. */
export interface ServerEvent {
  type: string;
  [k: string]: unknown;
}

/** What the page does about one server event. */
export type Action =
  | { kind: "user-said"; text: string }
  | { kind: "pilot-delta"; delta: string }
  | { kind: "pilot-said"; text: string }
  | { kind: "call"; callId: string; name: string; args: Record<string, unknown> }
  | { kind: "response-done"; hadCalls: boolean }
  | { kind: "speaking"; on: boolean }
  | { kind: "error"; message: string }
  | { kind: "none" };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The reducer: one event, one action. Anything unrecognized is `none` —
 * the API grows events, and the page must never trip on a new one. */
export function reduceEvent(e: ServerEvent): Action {
  switch (e.type) {
    case "conversation.item.input_audio_transcription.completed": {
      const text = str(e["transcript"]).trim();
      return text ? { kind: "user-said", text } : { kind: "none" };
    }
    case "response.output_audio_transcript.delta":
    case "response.output_text.delta": {
      const delta = str(e["delta"]);
      return delta ? { kind: "pilot-delta", delta } : { kind: "none" };
    }
    case "response.output_audio_transcript.done":
    case "response.output_text.done": {
      const text = str(e["transcript"] || e["text"]).trim();
      return text ? { kind: "pilot-said", text } : { kind: "none" };
    }
    case "response.function_call_arguments.done": {
      const callId = str(e["call_id"]);
      const name = str(e["name"]);
      if (!callId || !name) return { kind: "none" };
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(str(e["arguments"]) || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch {
        /* malformed arguments: the tool door refuses them with a reason */
      }
      return { kind: "call", callId, name, args };
    }
    case "response.done": {
      const response = (e["response"] ?? {}) as { output?: unknown };
      const output = Array.isArray(response.output) ? (response.output as { type?: unknown }[]) : [];
      return { kind: "response-done", hadCalls: output.some((item) => item?.type === "function_call") };
    }
    case "output_audio_buffer.started":
      return { kind: "speaking", on: true };
    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
      return { kind: "speaking", on: false };
    case "error": {
      const err = (e["error"] ?? {}) as { message?: unknown; code?: unknown };
      return { kind: "error", message: str(err.message) || str(err.code) || "the session reported an error" };
    }
    default:
      return { kind: "none" };
  }
}

/** Errors the session reports that are not worth a word on screen: an
 * empty commit is what a hold with nothing said produces, and the next hold
 * is the fix. */
export function isQuietError(message: string): boolean {
  return /buffer too small|buffer is empty|commit.*empty|no audio|no active response|no response.*cancel/i.test(message);
}

/** Realtime responses can finish after Escape or barge-in, including queued
 * function calls. Correlate them with the generation sent in response.create. */
export class PilotResponseGate {
  generation = 0;
  private responses = new Map<string, number>();
  next(): number { return ++this.generation; }
  current(generation: number): boolean { return generation === this.generation; }
  accept(event: ServerEvent): boolean {
    const response = event.response as { id?: string; metadata?: { pilot_generation?: string } } | undefined;
    if (event.type === "response.created" && response?.id) {
      this.responses.set(response.id, Number(response.metadata?.pilot_generation));
      if (this.responses.size > 100) this.responses.delete(this.responses.keys().next().value!);
    }
    const id = typeof event.response_id === "string" ? event.response_id : response?.id;
    if (id) return this.responses.get(id) === this.generation;
    // Non-response events (input transcription, session/errors) are independent.
    return !event.type.startsWith("response.");
  }
}

/** Where the screen goes when the pilot calls a tool — the "UI follows the
 * pilot" half of v0, and it is free: the pilot runs in the page. Reading a
 * note opens it; searching shows the hits. Nothing else moves the screen. */
export function navigationFor(name: string, args: Record<string, unknown>): { note: string } | { search: string } | null {
  if (name === "read_note") {
    const path = str(args["path"]).trim();
    return path ? { note: path } : null;
  }
  if (name === "search_vault") {
    const q = str(args["query"]).trim() || (Array.isArray(args["queries"]) ? args["queries"].filter(v => typeof v === "string").join(" OR ") : "");
    return q ? { search: q } : null;
  }
  return null;
}

/** The HUD's one-line state. */
export function phaseLabel(phase: Phase, held: boolean): string {
  switch (phase) {
    case "off":
      return "";
    case "idle":
    case "ready":
      return held ? "listening" : "hold space to talk";
    case "connecting":
      return "connecting…";
    case "listening":
      return "listening";
    case "thinking":
      return "thinking…";
    case "speaking":
      return "speaking — space interrupts";
    case "error":
      return "";
  }
}

/** A tap or a hold? The release decides. */
export const isTap = (heldMs: number): boolean => heldMs < MIN_HOLD_MS;
