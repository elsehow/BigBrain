import { describe, expect, test } from "bun:test";
import { sourceOrigin } from "../lib/sourceOrigin";

// where a source lives outside the vault, read off its envelope — the OPEN
// chip's target (lib/sourceOrigin.ts)
const SHA = "0fd8d8ad8eb09e88fbd4299b917deb7693cc9283aada2fe3730eb7a4fc5e6c8c";
const pdf = { name: "paper.pdf", sha256: SHA, bytes: 16841, mime: "application/pdf" };

describe("sourceOrigin", () => {
  test("stored text offers a Markdown note when there is no external original", () => {
    const note = { title: "Dropped reading", body: "Full text" };
    expect(sourceOrigin({ source: "api" }, note)).toEqual({ kind: "note", name: "Dropped reading.md" });
    expect(sourceOrigin({}, { ...note, body: "  " })).toBeNull();
    expect(sourceOrigin({ url: "https://example.com/" }, note)?.kind).toBe("url");
    expect(sourceOrigin({ attachments: [pdf] }, note)?.kind).toBe("file");
  });
  test("a web clip's url is the page", () => {
    expect(sourceOrigin({ source: "api", kind: "web-clip", url: "https://www.usenix.org/conference/osdi20/presentation/nelson" }))
      .toEqual({ kind: "url", url: "https://www.usenix.org/conference/osdi20/presentation/nelson" });
  });
  test("a granola note's url is the note on granola.ai", () => {
    expect(sourceOrigin({ source: "granola", url: "https://notes.granola.ai/d/73907e79", attendees: "Nick" }))
      .toEqual({ kind: "url", url: "https://notes.granola.ai/d/73907e79" });
  });
  test("a drop's original is its first attachment, by CAS address", () => {
    expect(sourceOrigin({ source: "web-drop", kind: "pdf-import", attachments: [pdf] }))
      .toEqual({ kind: "file", name: "paper.pdf", sha256: SHA, mime: "application/pdf", bytes: 16841 });
  });
  test("a page beats a file — a clip that carried both is still a clip of the page", () => {
    expect(sourceOrigin({ url: "https://example.com/x.pdf", attachments: [pdf] })).toEqual({ kind: "url", url: "https://example.com/x.pdf" });
  });
  test("only a web address opens a browser: other schemes and garbage fall through to the file, or to nothing", () => {
    expect(sourceOrigin({ url: "javascript:alert(1)", attachments: [pdf] })?.kind).toBe("file");
    expect(sourceOrigin({ url: "file:///etc/passwd" })).toBeNull();
    expect(sourceOrigin({ url: "not a url" })).toBeNull();
    expect(sourceOrigin({ url: "   " })).toBeNull();
    expect(sourceOrigin({ url: 42 })).toBeNull();
  });
  test("an attachment without a real sha256 is no address; a nameless one is named by its hash; missing mime/bytes default", () => {
    expect(sourceOrigin({ attachments: [{ name: "x.pdf", sha256: "../../etc" }] })).toBeNull();
    expect(sourceOrigin({ attachments: [{ sha256: SHA }] })).toEqual({ kind: "file", name: SHA, sha256: SHA, mime: "application/octet-stream", bytes: 0 });
    expect(sourceOrigin({ attachments: "nope" })).toBeNull();
    expect(sourceOrigin({ attachments: [] })).toBeNull();
  });
  test("a voice note, a typed capture, a bootstrap: nothing to open", () => {
    expect(sourceOrigin({ source: "voice", kind: "voice" })).toBeNull();
    expect(sourceOrigin({})).toBeNull();
  });
});
