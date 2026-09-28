/**
 * lib/httpx.ts — the node:http route kit web/server.ts and bin/desktop.ts's
 * first-run door share (#639). Both were `if` chains with their own body
 * reader and their own JSON reply; the matcher and the cap are the parts
 * whose edges are worth pinning, since a wrong answer here is a route that
 * silently stops existing.
 */
import { describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { armor, CSP, dispatch, json, readBody, routeMatches, type Route } from "../lib/httpx";
import { createServer } from "node:http";

const get = (path: string): Route => ({ method: "GET", path, handler: () => {} });

describe("readBody", () => {
  test("collects a body; over the cap it rejects AND destroys the socket", async () => {
    const ok = new PassThrough();
    const p = readBody(ok as unknown as IncomingMessage);
    ok.end('{"model":"x"}');
    expect(await p).toBe('{"model":"x"}');

    // The destroy is the point: a caller that has already refused the
    // upload must not go on paying for the rest of it.
    const big = new PassThrough();
    const capped = readBody(big as unknown as IncomingMessage, 8);
    big.write("123456789");
    await expect(capped).rejects.toThrow(/too large/);
    expect(big.destroyed).toBe(true);
  });

  test("the cap counts BYTES, not characters", async () => {
    // The door's old reader accumulated a utf8 STRING and capped its
    // length, so a body of multi-byte characters got several times the
    // cap it asked for. Four emoji are 4 characters and 16 bytes.
    const s = new PassThrough();
    const p = readBody(s as unknown as IncomingMessage, 8);
    s.write("🙂🙂🙂🙂");
    await expect(p).rejects.toThrow(/too large/);
  });
});

describe("routeMatches", () => {
  test("an exact path is exact — no prefix, no trailing slash", () => {
    expect(routeMatches(get("/api/note"), "GET", "/api/note")).toBe(true);
    expect(routeMatches(get("/api/note"), "GET", "/api/note-log")).toBe(false);
    expect(routeMatches(get("/api/note"), "GET", "/api/note/")).toBe(false);
    expect(routeMatches(get("/"), "GET", "/anything")).toBe(false);
  });

  test("a `/prefix/*` entry matches everything under it, and nothing above", () => {
    expect(routeMatches(get("/assets/*"), "GET", "/assets/app.js")).toBe(true);
    expect(routeMatches(get("/assets/*"), "GET", "/assets/nested/app.js")).toBe(true);
    expect(routeMatches(get("/assets/*"), "GET", "/assets")).toBe(false);
    expect(routeMatches(get("/assets/*"), "GET", "/assetsx/app.js")).toBe(false);
  });

  test("the method is part of the match — this is what the if-chain left implied", () => {
    expect(routeMatches(get("/api/vault"), "POST", "/api/vault")).toBe(false);
    expect(routeMatches({ ...get("/api/drop"), method: "POST" }, "POST", "/api/drop")).toBe(true);
  });
});

describe("dispatch", () => {
  const req = (url: string, method = "GET"): IncomingMessage =>
    ({ url, method }) as IncomingMessage;
  const res = {} as ServerResponse;

  test("runs the first match and says so; says nothing matched otherwise", () => {
    const seen: string[] = [];
    const routes: Route[] = [
      { method: "GET", path: "/api/note", handler: () => seen.push("note") },
      { method: "GET", path: "/api/note", handler: () => seen.push("shadowed") },
    ];
    expect(dispatch(routes, req("/api/note"), res)).toBe(true);
    expect(seen).toEqual(["note"]);
    // No match: dispatch does NOT answer — each server words its own 404
    // ("not found" in the viewer, "no vault yet" at the door).
    expect(dispatch(routes, req("/api/nope"), res)).toBe(false);
    expect(dispatch(routes, req("/api/note", "DELETE"), res)).toBe(false);
    expect(seen).toEqual(["note"]);
  });

  test("the query is parsed off the path, and reaches the handler", () => {
    const seen: URL[] = [];
    const routes: Route[] = [
      { method: "GET", path: "/api/search", handler: ({ url }) => seen.push(url) },
    ];
    expect(dispatch(routes, req("/api/search?q=evan%20keller&limit=5"), res)).toBe(true);
    expect(seen[0]!.pathname).toBe("/api/search");
    expect(seen[0]!.searchParams.get("q")).toBe("evan keller");
    expect(seen[0]!.searchParams.get("limit")).toBe("5");
  });

  test("a missing method is GET, and the method is compared case-blind", () => {
    let hits = 0;
    const routes: Route[] = [{ method: "GET", path: "/", handler: () => hits++ }];
    expect(dispatch(routes, { url: "/" } as IncomingMessage, res)).toBe(true);
    expect(dispatch(routes, req("/", "get"), res)).toBe(true);
    expect(hits).toBe(2);
  });
});

describe("armor — the viewer's security headers (#692)", () => {
  test("the policy: this origin's scripts only, nothing inline or eval'd, no framing, no plugins", () => {
    const d = Object.fromEntries(CSP.split("; ").map((x) => [x.split(" ")[0], x.split(" ").slice(1)]));
    expect(d["script-src"]).toEqual(["'self'"]);
    expect(CSP).not.toContain("unsafe-eval");
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["frame-src"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    // the Tauri IPC transport, both spellings — the webview shows this
    // same page, so this header is the desktop app's CSP as well
    // …plus OpenAI, where the pilot (#770) offers its WebRTC call with a
    // client secret the engine minted — the page's one call off the origin
    expect(d["connect-src"]).toEqual(["'self'", "ipc:", "http://ipc.localhost", "https://api.openai.com"]);
    // pdf.js runs its worker from the bundle; vault images ride /api/file
    expect(d["worker-src"]).toContain("'self'");
    expect(d["img-src"]).toContain("'self'");
    // the typeface tokens.css imports — measured 2026-09-01: without these
    // two the stylesheet is refused and the viewer falls back to system-ui
    expect(d["style-src"]).toContain("https://fonts.googleapis.com");
    expect(d["font-src"]).toContain("https://fonts.gstatic.com");
  });

  test("set before the route, the headers survive a later writeHead — on a 200 and on a 404 alike", async () => {
    const server = createServer((req, res) => {
      armor(res);
      if (req.url === "/ok") return json(res, 200, { ok: true });
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    for (const path of ["/ok", "/missing"]) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(r.headers.get("content-security-policy")).toBe(CSP);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
    server.close();
  });
});
