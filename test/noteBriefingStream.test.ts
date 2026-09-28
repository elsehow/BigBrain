import { afterEach, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { noteBriefingRoutes } from "../lib/noteBriefing";
import { cachedNoteBriefing, clearNoteBriefingCache, readNoteBriefing } from "../web/ui/src/lib/noteBriefing";

const fetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetch; clearNoteBriefingCache(); });
const briefing = { key: "test", model: "test", generatedAt: "now", summary: "Maya · Atlas", links: [] };
const selection = { selected: ["a", "b"], excluded: ["c"] };

test("the stream reader delivers summary before completion and preserves chunked UTF-8", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = (async (_url, init) => {
    if (_url === "/api/vault") return Response.json({});
    expect(JSON.parse(String(init?.body))).toEqual({ ...selection, stream: true });
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "application/x-ndjson" } });
  }) as typeof fetch;
  const previews: string[] = [];
  let complete = false;
  const result = readNoteBriefing(selection, text => previews.push(text), new AbortController().signal).then(value => { complete = true; return value; });
  await Bun.sleep(1);
  const bytes = new TextEncoder().encode(JSON.stringify({ type: "preview", text: briefing.summary }) + "\n");
  for (const byte of bytes) stream.enqueue(new Uint8Array([byte]));
  await Bun.sleep(1);
  expect(previews).toEqual([briefing.summary]);
  expect(complete).toBe(false);
  stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: "complete", briefing }) + "\n"));
  expect(await result).toEqual(briefing);
  expect(cachedNoteBriefing(selection)).toEqual(briefing);
});

test("completed selections are synchronous cache hits across order changes, while exclusions and aborted results stay separate", async () => {
  globalThis.fetch = (async () => Response.json({ briefing })) as typeof fetch;
  await readNoteBriefing(selection, () => {}, new AbortController().signal);
  expect(cachedNoteBriefing({ selected: ["b", "a", "a"], excluded: ["c"] })).toEqual(briefing);
  expect(cachedNoteBriefing({ ...selection, excluded: [] })).toBeUndefined();
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = (async () => Response.json({ briefing: { ...briefing, summary: "Superseded" } })) as typeof fetch;
  await readNoteBriefing(selection, () => {}, controller.signal);
  expect(cachedNoteBriefing(selection)?.summary).toBe(briefing.summary);
});

test("a broken or rejected stream becomes a retryable error", async () => {
  for (const body of ['{"type":"preview","text":"Partial"}\n', '{"type":"error","error":"Please retry"}\n']) {
    globalThis.fetch = (async () => new Response(body, { headers: { "content-type": "application/x-ndjson" } })) as typeof fetch;
    await expect(readNoteBriefing(selection, () => {}, new AbortController().signal)).rejects.toThrow();
    expect(cachedNoteBriefing(selection)).toBeUndefined();
  }
});

test("the endpoint accepts declarative selections, streams before completion, and rejects malformed requests", async () => {
  const requests: unknown[] = [];
  const routes = noteBriefingRoutes("unused", async (_root, request, preview) => {
    requests.push(request);
    preview?.(briefing.summary);
    return briefing;
  });
  async function call(body: unknown) {
    let status = 0;
    const chunks: string[] = [];
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    const res = new EventEmitter() as any;
    const ended = new Promise<void>(resolve => { res.end = (text?: string) => { if (text) chunks.push(text); resolve(); }; });
    res.writeHead = (code: number) => { status = code; };
    res.flushHeaders = () => {};
    res.write = (text: string) => chunks.push(text);
    routes[0]!.handler({ req, res } as never);
    await ended;
    return { status, chunks };
  }
  const result = await call({ ...selection, stream: true });
  expect(result.status).toBe(200);
  expect(result.chunks.map(chunk => JSON.parse(chunk).type)).toEqual(["preview", "complete"]);
  expect(requests).toEqual([selection]);
  for (const body of [{ selected: [] }, { selected: [1] }, { selected: ["a"], excluded: "b" }, null])
    expect((await call(body)).status).toBe(400);
  expect(requests).toHaveLength(1);
  expect((await call({ path: "memory/a.md" })).status).toBe(200);
  expect(requests.at(-1)).toBe("memory/a.md");
});
