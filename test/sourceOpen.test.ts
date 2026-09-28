import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { putBlob } from "../lib/blobs";
import { dispatch, type Route } from "../lib/httpx";
import { appendSourceInsertionEvent, insertionEventRel } from "../lib/insertionLog";
import { materializedPath, openSourceOrigin, safeName, sourceOpenRoutes } from "../lib/sourceOpen";
import { insertion } from "./support/vault";

// the door that opens a source's origin on this machine (lib/sourceOpen.ts)
const tmp = (): string => mkdtempSync(join(tmpdir(), "bb-open-"));

function land(root: string, envelope: Record<string, unknown>, id = `ins_${"1".repeat(24)}`, body = ""): string {
  const ev = insertion({ id, envelope, body, received_at: "2026-09-04T10:00:00.000Z" });
  appendSourceInsertionEvent(root, ev);
  return insertionEventRel(ev);
}

describe("names", () => {
  test("a filename the OS will take: separators and NULs out, hidden-file dots off, the hash when nothing is left", () => {
    expect(safeName("Paper (final).pdf", "h")).toBe("Paper (final).pdf");
    expect(safeName("../../evil.pdf", "h")).toBe("_.._evil.pdf");
    expect(safeName("a\0b", "h")).toBe("a_b");
    expect(safeName("...", "h")).toBe("h");
    expect(safeName("", "h")).toBe("h");
  });
  test("one folder per blob, the name inside as it arrived", () => {
    const SHA = "ab".repeat(32);
    expect(materializedPath(SHA, "paper.pdf", "/base")).toBe(`/base/${SHA}/paper.pdf`);
  });
});

describe("openSourceOrigin", () => {
  test("a dropped note opens its full text as Markdown and preserves edits to the copy", () => {
    const root = tmp();
    const base = join(tmp(), "open");
    const body = "An initial reading.\n\n## Reflections\n\nA second paragraph.";
    const path = land(root, { source: "api" }, undefined, body);
    const record = readFileSync(join(root, path), "utf8");
    const opened: string[] = [];
    const opener = (target: string) => { opened.push(target); return true; };
    const result = openSourceOrigin(root, path, opener, base);
    expect(result).toMatchObject({ ok: true, origin: { kind: "note" } });
    expect(opened[0]).toEndWith(".md");
    expect(readFileSync(opened[0]!, "utf8")).toContain(body);
    writeFileSync(opened[0]!, "Edited copy");
    expect(openSourceOrigin(root, path, opener, base).ok).toBe(true);
    expect(opened[1]).toBe(opened[0]!);
    expect(readFileSync(opened[0]!, "utf8")).toBe("Edited copy");
    expect(readFileSync(join(root, path), "utf8")).toBe(record);
    expect(openSourceOrigin(root, path, () => false, base)).toMatchObject({ ok: false, origin: { kind: "note" } });
  });
  test("a file origin: the original is copied out under its name, once, and handed to the opener", () => {
    const root = tmp();
    const base = join(tmp(), "open");
    const bytes = new TextEncoder().encode("%PDF-1.4 hello");
    const { sha256 } = putBlob(root, bytes);
    const path = land(root, { source: "web-drop", attachments: [{ name: "paper.pdf", sha256, bytes: bytes.length, mime: "application/pdf" }] });
    const opened: string[] = [];
    const r = openSourceOrigin(root, path, (t) => { opened.push(t); return true; }, base);
    expect(r.ok).toBe(true);
    const dest = join(base, sha256, "paper.pdf");
    expect(opened).toEqual([dest]);
    expect(readFileSync(dest, "utf8")).toBe("%PDF-1.4 hello");
    // again: same copy, no second write — the opener just gets the path
    expect(openSourceOrigin(root, path, (t) => { opened.push(t); return true; }, base).ok).toBe(true);
    expect(opened).toEqual([dest, dest]);
  });
  test("a url origin goes to the opener as it is", () => {
    const root = tmp();
    const path = land(root, { source: "granola", url: "https://notes.granola.ai/d/1" });
    const opened: string[] = [];
    expect(openSourceOrigin(root, path, (t) => { opened.push(t); return true; })).toEqual({ ok: true, origin: { kind: "url", url: "https://notes.granola.ai/d/1" }, opened: "https://notes.granola.ai/d/1" });
  });
  test("refusals say why: no such source, no origin, the original gone from the CAS, an opener that cannot", () => {
    const root = tmp();
    const base = join(tmp(), "open");
    const never = (): boolean => { throw new Error("must not open"); };
    expect(openSourceOrigin(root, "log/insertions/2026-09/ins_nope.json", never)).toMatchObject({ ok: false, error: "no such source" });
    expect(openSourceOrigin(root, "../../etc/passwd", never)).toMatchObject({ ok: false, error: "no such source" });
    const voice = land(root, { source: "voice" }, `ins_${"2".repeat(24)}`);
    expect(openSourceOrigin(root, voice, never)).toMatchObject({ ok: false, origin: null });
    const gone = land(root, { attachments: [{ name: "x.pdf", sha256: "cd".repeat(32) }] }, `ins_${"3".repeat(24)}`);
    const r = openSourceOrigin(root, gone, never, base);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("x.pdf");
    expect(existsSync(join(base, "cd".repeat(32)))).toBe(false);
    const page = land(root, { url: "https://x.example/" }, `ins_${"4".repeat(24)}`);
    expect(openSourceOrigin(root, page, () => false)).toMatchObject({ ok: false, error: "could not open a browser here" });
  });
});

describe("the route", () => {
  test("POST /api/source/open opens the file and answers with what it opened; a miss is 404, a refusal 500, no body 400", async () => {
    const root = tmp();
    const base = join(tmp(), "open");
    const { sha256 } = putBlob(root, new TextEncoder().encode("doc"));
    const path = land(root, { attachments: [{ name: "notes.docx", sha256 }] });
    const opened: string[] = [];
    const routes = sourceOpenRoutes(root, (t) => { opened.push(t); return true; }, base);
    const ok = await call(routes, "POST", "/api/source/open", JSON.stringify({ path }));
    expect(ok.code).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ ok: true, opened: join(base, sha256, "notes.docx"), origin: { kind: "file", name: "notes.docx" } });
    expect(opened).toEqual([join(base, sha256, "notes.docx")]);
    const miss = await call(routes, "POST", "/api/source/open", JSON.stringify({ path: "log/insertions/2026-09/ins_x.json" }));
    expect(miss.code).toBe(404);
    const stuck = await call(sourceOpenRoutes(root, () => false, base), "POST", "/api/source/open", JSON.stringify({ path }));
    expect(stuck.code).toBe(500);
    expect(JSON.parse(stuck.body).error).toContain("open a file");
    expect((await call(routes, "POST", "/api/source/open", "not json")).code).toBe(400);
  });
});

// the routes, dispatched as web/server.ts would (test/themes.test.ts's twin, with a body)
function call(routes: Route[], method: string, path: string, body = ""): Promise<{ code: number; body: string }> {
  return new Promise((resolve) => {
    const req = Object.assign(new PassThrough(), { method, url: path, headers: { host: "127.0.0.1" } });
    let code = 0;
    let out = "";
    const res = {
      writeHead: (c: number) => { code = c; },
      setHeader() {},
      write: (b: string) => { out += b; },
      end: (b?: string) => { out += b ?? ""; resolve({ code, body: out }); },
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    dispatch(routes, req as any, res as any);
    req.end(body);
  });
}
