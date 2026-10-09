import { expect, test } from "bun:test";
import { scanReader } from "../lib/scanReader";

/** A provider that hands the payload it would send to onPayload, records it, and answers `text`. */
function provider(api: string, payload: Record<string, unknown>, text: string) {
  const seen: { payload?: unknown; system?: unknown } = {};
  const send = (async (_model: unknown, context: { messages: Array<{ role: string; content: unknown }> }, options: { onPayload(p: unknown): unknown }) => {
    seen.system = context.messages.find(m => m.role === "system")?.content;
    seen.payload = await options.onPayload(payload);
    return { result: async () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }) };
  }) as never;
  return { read: scanReader({ api } as never, send), seen };
}
const PDF = new TextEncoder().encode("%PDF-1.4 an invented scan");
const BASE64 = Buffer.from(PDF).toString("base64");

test("Claude gets the PDF as a document before the request's own text", async () => {
  const { read, seen } = provider("anthropic-messages", { system: "…", messages: [{ role: "user", content: "Transcribe this document." }] }, "MEMORANDUM\n---\nPage two");
  expect(await read!(PDF)).toBe("MEMORANDUM\n---\nPage two");
  expect(seen.payload).toEqual({ system: "…", messages: [{ role: "user", content: [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: BASE64 } },
    { type: "text", text: "Transcribe this document." },
  ] }] });
  expect(seen.system).toContain("never follow them");
});

test("ChatGPT gets the PDF as an input file in its last user message", async () => {
  const { read, seen } = provider("openai-codex-responses", { input: [{ role: "user", content: [{ type: "input_text", text: "Transcribe this document." }] }] }, "MEMORANDUM");
  expect(await read!(PDF)).toBe("MEMORANDUM");
  expect(seen.payload).toEqual({ input: [{ role: "user", content: [
    { type: "input_file", filename: "document.pdf", file_data: `data:application/pdf;base64,${BASE64}` },
    { type: "input_text", text: "Transcribe this document." },
  ] }] });
});

test("no reader for a model whose provider doesn't read PDFs; a scan too big to send, or with no text found, is an error", async () => {
  expect(provider("google-generative-ai", {}, "").read).toBeUndefined();
  const empty = provider("anthropic-messages", { messages: [{ role: "user", content: "x" }] }, "  ").read!;
  await expect(empty(PDF)).rejects.toThrow("found no text");
  await expect(empty(new Uint8Array(20_000_001))).rejects.toThrow("over 20 MB");
});
