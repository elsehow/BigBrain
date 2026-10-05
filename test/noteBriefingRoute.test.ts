import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { noteBriefingRoutes } from "../lib/noteBriefing";

const briefing = { key: "test", model: "test", generatedAt: "now", summary: "Maya · Atlas", links: [] };
const selection = { selected: ["a", "b"], excluded: ["c"] };

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
