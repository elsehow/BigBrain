import { describe, expect, test } from "bun:test";
import { openOrigin, originHint, originLabel } from "../web/ui/src/lib/origin";

// the viewer's OPEN: which opener takes which origin (web/ui/src/lib/origin.ts)
const SHA = "ab".repeat(32);

describe("openOrigin", () => {
  test("a stored note opens through the engine and describes its Markdown copy", async () => {
    const note = { kind: "note" as const, name: "Reading.md" };
    const asked: string[] = [];
    await openOrigin(note, "source-path", {
      external: () => { throw new Error("not a URL"); },
      engine: async (path) => { asked.push(path); },
    });
    expect(asked).toEqual(["source-path"]);
    expect(originHint(note)).toContain("Markdown");
  });
  test("a page leaves the app the way every outbound link does; the engine is never asked", async () => {
    const external: string[] = [];
    let engine = 0;
    await openOrigin({ kind: "url", url: "https://x.example/p" }, "log/insertions/2026-09/ins_1.json", {
      external: (u) => { external.push(u); },
      engine: async () => { engine++; },
    });
    expect(external).toEqual(["https://x.example/p"]);
    expect(engine).toBe(0);
  });
  test("a file goes to the engine's door by the note's path; its refusal is the caller's to show", async () => {
    const asked: string[] = [];
    const file = { kind: "file" as const, name: "paper.pdf", sha256: SHA, mime: "application/pdf", bytes: 3 };
    await openOrigin(file, "log/insertions/2026-09/ins_1.json", {
      external: () => { throw new Error("not a browser matter"); },
      engine: async (p) => { asked.push(p); },
    });
    expect(asked).toEqual(["log/insertions/2026-09/ins_1.json"]);
    // by its sha256: a source that also has a page opens this file, not the page
    const shas: (string | undefined)[] = [];
    await openOrigin(file, "p", { external: () => {}, engine: async (_p, sha) => { shas.push(sha); } });
    expect(shas).toEqual([SHA]);
    await expect(openOrigin(file, "p", { external: () => {}, engine: async () => { throw new Error("no reader"); } })).rejects.toThrow("no reader");
  });
  test("one of several originals is named by its site or its file", () => {
    expect(originLabel({ kind: "url", url: "https://www.arxiv.example/pdf/1" })).toBe("arxiv.example");
    expect(originLabel({ kind: "file", name: "paper.pdf", sha256: SHA, mime: "", bytes: 0 })).toBe("paper.pdf");
  });
  test("the hover says where ⌘O goes", () => {
    expect(originHint({ kind: "url", url: "https://x.example/p" })).toContain("https://x.example/p");
    expect(originHint({ kind: "file", name: "paper.pdf", sha256: SHA, mime: "", bytes: 0 })).toContain("paper.pdf");
  });
});
