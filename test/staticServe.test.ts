import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { contentTypeFor, serveStatic, staticHeaders } from "../lib/staticServe";

// Pins the static leg's POLICY as extracted from web/server.ts (#260):
// extension → content-type, and the two cache postures — hashed /assets/
// filenames may cache forever, everything else (index.html above all) must
// revalidate, or a stale shell points at assets that no longer exist.

describe("staticHeaders", () => {
  test("known extensions map to their types", () => {
    expect(staticHeaders("/ui/dist/index.html")["content-type"]).toBe("text/html");
    expect(staticHeaders("/ui/dist/assets/index-C21W.js")["content-type"]).toBe("text/javascript");
    expect(staticHeaders("/ui/dist/assets/app.css")["content-type"]).toBe("text/css");
    expect(staticHeaders("/vault/inbox/scan.pdf")["content-type"]).toBe("application/pdf");
    expect(staticHeaders("/vault/inbox/photo.heic")["content-type"]).toBe("image/heic");
  });
  test("anything unrecognized ships as octet-stream, never a guess", () => {
    expect(staticHeaders("/vault/inbox/data.sqlite")["content-type"]).toBe(
      "application/octet-stream"
    );
    expect(staticHeaders("no-extension")["content-type"]).toBe("application/octet-stream");
  });
  test("the text types both doors share (#259) — lib/api.ts adds its charset on top", () => {
    expect(contentTypeFor("entities/ada.md")).toBe("text/markdown");
    expect(contentTypeFor("inbox/unsorted/notes.TXT")).toBe("text/plain");
    expect(contentTypeFor("journal/run.json")).toBe("application/json");
    expect(contentTypeFor("references/data.yaml")).toBe("text/yaml");
    expect(contentTypeFor("references/data.yml")).toBe("text/yaml");
    expect(contentTypeFor("references/table.csv")).toBe("text/csv");
    expect(contentTypeFor("mystery")).toBe("application/octet-stream");
  });
  test("every static path carries nosniff (#552)", () => {
    expect(staticHeaders("/ui/dist/index.html")["x-content-type-options"]).toBe("nosniff");
    expect(staticHeaders("/vault/inbox/photo.png")["x-content-type-options"]).toBe("nosniff");
    expect(staticHeaders("/vault/inbox/mystery")["x-content-type-options"]).toBe("nosniff");
  });
  test("only /assets/ paths cache hard; the shell must revalidate", () => {
    expect(staticHeaders("/ui/dist/assets/index-C21W.js")["cache-control"]).toBe(
      "max-age=31536000, immutable"
    );
    expect(staticHeaders("/ui/dist/index.html")["cache-control"]).toBe("no-cache");
    expect(staticHeaders("/vault/inbox/photo.png")["cache-control"]).toBe("no-cache");
  });
});

describe("serveStatic", () => {
  function fakeRes(): {
    res: ServerResponse;
    got: () => { code?: number; headers?: unknown; body?: Buffer };
  } {
    const state: { code?: number; headers?: unknown; body?: Buffer } = {};
    const res = {
      writeHead(code: number, headers: unknown) {
        state.code = code;
        state.headers = headers;
      },
      end(body: Buffer) {
        state.body = body;
      },
    } as unknown as ServerResponse;
    return { res, got: () => state };
  }

  test("an existing file answers 200 with its bytes and policy headers", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-static-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    const { res, got } = fakeRes();
    expect(serveStatic(res, join(dir, "assets", "app.js"))).toBe(true);
    expect(got().code).toBe(200);
    expect(got().headers).toEqual({
      "content-type": "text/javascript",
      "x-content-type-options": "nosniff",
      "cache-control": "max-age=31536000, immutable",
    });
    expect(got().body?.toString()).toBe("console.log(1)");
  });

  test("vault files force attachment so html/svg never renders inline (#552)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-static-"));
    writeFileSync(join(dir, "evil.svg"), "<svg onload=alert(1)></svg>");
    const { res, got } = fakeRes();
    expect(serveStatic(res, join(dir, "evil.svg"), { download: true })).toBe(true);
    const h = got().headers as Record<string, string>;
    expect(h["content-disposition"]).toBe("attachment");
    expect(h["x-content-type-options"]).toBe("nosniff");
    // still typed honestly — the disposition, not a wrong type, is what defangs it
    expect(h["content-type"]).toBe("image/svg+xml");
  });

  test("the trusted app shell is NOT forced to download (no download opt)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-static-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    const { res, got } = fakeRes();
    expect(serveStatic(res, join(dir, "index.html"))).toBe(true);
    const h = got().headers as Record<string, string>;
    expect(h["content-disposition"]).toBeUndefined();
    expect(h["x-content-type-options"]).toBe("nosniff"); // sniff-guard still on
  });

  test("a missing file answers nothing and returns false — the route decides the 404", () => {
    const { res, got } = fakeRes();
    expect(serveStatic(res, "/nowhere/at/all.html")).toBe(false);
    expect(got().code).toBeUndefined();
  });
});
