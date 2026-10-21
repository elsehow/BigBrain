import { afterEach, expect, test } from "bun:test";
import { readBriefing } from "../web/ui/src/lib/noteBriefing";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
function transport(response: () => Response, requests: unknown[] = []) {
  globalThis.fetch = (async (input, init) => {
    if (input === "/api/vault") return Response.json({});
    requests.push(JSON.parse(String(init?.body)));
    return response();
  }) as typeof fetch;
}

test("source summaries stream across split chunks and accept a final line without a newline", async () => {
  const requests: unknown[] = [], text: string[] = [];
  transport(() => new Response(new ReadableStream({ start(controller) {
    for (const chunk of ['{"type":"pre', 'view","text":"A draft"}\n', '{"type":"complete","briefing":{"summary":"Final summary"}}'])
      controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } })), requests);
  expect(await readBriefing("source.md", t => text.push(t), { lens: "lens_000000000001" })).toBe(true);
  expect(text).toEqual(["A draft", "Final summary"]);
  expect(requests).toEqual([{ path: "source.md", stream: true, scope: { lens: "lens_000000000001" } }]);
});

test("a shared source's summary reads its server, while explicit scope is preserved", async () => {
  const requests: unknown[] = [];
  transport(() => new Response('{"type":"complete","briefing":{"summary":"A source"}}\n'), requests);
  await readBriefing("shared/example/source.md", () => {});
  await readBriefing("shared/example/source.md", () => {}, { server: "focused" });
  expect(requests).toEqual([
    { path: "shared/example/source.md", stream: true, scope: { server: "example" } },
    { path: "shared/example/source.md", stream: true, scope: { server: "focused" } },
  ]);
});

test("failed or aborted summaries do not report completion or update a departed view", async () => {
  const text: string[] = [];
  transport(() => new Response('{"type":"error","error":"Unavailable"}\n'));
  expect(await readBriefing("source.md", t => text.push(t))).toBe(false);
  const controller = new AbortController(); controller.abort();
  transport(() => new Response('{"type":"complete","briefing":{"summary":"Too late"}}\n'));
  expect(await readBriefing("source.md", t => text.push(t), undefined, controller.signal)).toBe(false);
  expect(text).toEqual([]);
});
