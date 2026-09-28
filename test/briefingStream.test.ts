import { expect, test } from "bun:test";
import { readNoteBriefing, clearNoteBriefingCache } from "../web/ui/src/lib/noteBriefing";

test("briefing stream decodes split UTF-8, previews and a final record without a trailing newline", async () => {
  const original = globalThis.fetch;
  const briefing = { key: "cache-key", summary: "Renée’s project", links: [], model: "haiku", generatedAt: "2026-09-10" };
  const bytes = new TextEncoder().encode(`${JSON.stringify({ type: "preview", text: "Renée’s project" })}\n${JSON.stringify({ type: "complete", briefing })}`);
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) {
    // One byte per chunk splits both JSON and multibyte characters.
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }), { headers: { "content-type": "application/x-ndjson" } })) as typeof fetch;
  try {
    const previews: string[] = [];
    expect(await readNoteBriefing({ selected: ["entity"], excluded: [] }, text => previews.push(text), new AbortController().signal)).toEqual(briefing);
    expect(previews).toEqual(["Renée’s project"]);
  } finally { globalThis.fetch = original; clearNoteBriefingCache(); }
});

test("briefing stream surfaces model errors and never treats a disconnected preview as complete", async () => {
  const original = globalThis.fetch;
  try {
    for (const [event, message] of [
      [{ type: "error", error: "Claude is unavailable" }, "Claude is unavailable"],
      [{ type: "preview", text: "Half a thought" }, "stopped before it finished"],
    ] as const) {
      globalThis.fetch = (async () => new Response(`${JSON.stringify(event)}\n`, { headers: { "content-type": "application/x-ndjson" } })) as typeof fetch;
      await expect(readNoteBriefing({ selected: ["entity"], excluded: [] }, () => {}, new AbortController().signal)).rejects.toThrow(message);
    }
  } finally { globalThis.fetch = original; clearNoteBriefingCache(); }
});
