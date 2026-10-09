/**
 * askModel.ts — one request to a desktop's own model, for a host tool that
 * needs what only its provider does: search the web (lib/webSearch.ts), or
 * read a scanned PDF (lib/scanReader.ts). It goes through `send`, the
 * host's credential wrapper (lib/agentHost.ts), and each tool changes the
 * payload for its API.
 */
import type { OpenOptions } from "../packages/agents/src";

export type StreamFn = Parameters<NonNullable<OpenOptions["wrapStream"]>>[0];
export type Model = Parameters<StreamFn>[0];

/** The model's answer to one instruction and one message, as text; a failed request throws. */
export async function askModel(send: StreamFn, model: Model, ask: {
  system: string; user: string; signal?: AbortSignal;
  onPayload(payload: unknown): unknown; onProviderStreamEvent?(event: unknown): void;
}): Promise<string> {
  const { normalizeContext } = await import("@earendil-works/pi-ai");
  const context = normalizeContext({ systemPrompt: ask.system, messages: [{ role: "user", content: ask.user, timestamp: Date.now() }] });
  const stream = await send(model, context, { signal: ask.signal, reasoning: "low", onPayload: ask.onPayload, onProviderStreamEvent: ask.onProviderStreamEvent });
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? "The request did not finish.");
  return message.content.flatMap(b => b.type === "text" ? [b.text] : []).join("").trim();
}
