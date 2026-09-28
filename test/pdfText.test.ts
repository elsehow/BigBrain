/**
 * The door's PDF text layer (lib/pdfText.ts). The extension ships a PDF
 * as one stub sentence plus the bytes (#63); the editor pass that used to
 * extract host-side retired with #543 and the gardener has no shell — so
 * the host extracts on landing, pure JS, no poppler. These pin: the walk
 * itself against hand-built PDFs; which items the composer touches (a
 * `kind: pdf-import`/`pdf` STUB, nothing else); what it writes (a `## Text
 * layer` section, a real title over a filename, pages/author/date); and
 * that an unreadable document lands as the stub it arrived as.
 */
import { describe, expect, test } from "bun:test";
import { discussablePdf, extractPdfText, isPdf } from "../lib/pdfText";
import { tinyPdf } from "./support/tinyPdf";

// Enough prose to clear the thin threshold (200 non-whitespace chars).
const PARA = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of a real paper about forecasting and task horizons.`).join("\n");
const b64 = (b: Buffer): string => b.toString("base64");

// The extension's stub, verbatim shape (clients/browser-extension/background.js capturePdf).
const STUB =
  "---\nfrom: send-to-bigbrain\nfrom_kind: agent\ntitle: \"BRIDGE paper - 2602.07267v2.pdf\"\nurl: https://arxiv.org/pdf/2602.07267v2\nsite: arxiv.org\nfilename: 2602.07267v2.pdf\nkind: pdf-import\n---\n\n" +
  "Captured from the browser's PDF viewer. The document rides as the attachment below; its text was not extracted at capture time.\n";

describe("isPdf", () => {
  test("magic anywhere in the first kilobyte, and nowhere else", () => {
    expect(isPdf(Buffer.from("%PDF-1.4 x"))).toBe(true);
    expect(isPdf(Buffer.concat([Buffer.alloc(500, 0x20), Buffer.from("%PDF-1.7")]))).toBe(true);
    expect(isPdf(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isPdf(Buffer.concat([Buffer.alloc(2000, 0x20), Buffer.from("%PDF-1.7")]))).toBe(false);
  });
});

describe("extractPdfText", () => {
  test("walks every page, reads the Info dictionary, pages joined by a rule", async () => {
    const ex = await extractPdfText(
      tinyPdf([PARA, "Second page here."], { Title: "A Real Title Here", Author: "Ada Lovelace", CreationDate: "D:20260115093000-08'00'" })
    );
    expect(ex.pages).toBe(2);
    expect(ex.pagesRead).toBe(2);
    expect(ex.text).toContain("Line 1 of a real paper");
    expect(ex.text).toContain("\n\n---\n\nSecond page here.");
    expect(ex.title).toBe("A Real Title Here");
    expect(ex.author).toBe("Ada Lovelace");
    expect(ex.created).toBe("2026-01-15");
    expect(ex.thin).toBe(false);
  });

  test("a near-empty text layer is reported thin, not shipped as content", async () => {
    const ex = await extractPdfText(tinyPdf(["x"]));
    expect(ex.thin).toBe(true);
    expect(ex.text).toBe("x");
  });

  test("maxChars stops the walk and says how far it got", async () => {
    const ex = await extractPdfText(tinyPdf([PARA, PARA, PARA]), { maxChars: 10 });
    expect(ex.pages).toBe(3);
    expect(ex.pagesRead).toBe(1);
    expect(ex.text.length).toBe(10);
  });

  test("an unreadable document throws — the composer decides what that means", async () => {
    await expect(extractPdfText(Buffer.from("%PDF-1.4 minimal"))).rejects.toThrow();
  });
});

describe("discussablePdf", () => {
  const meta = { Title: "BRIDGE: Predicting Human Task Completion Time", Author: "Liu; Gala" };

  test("the extension's stub gets its text layer, a real title, pages, author; the stub and the client's keys stay", async () => {
    const out = await discussablePdf(STUB, [{ name: "2602.07267v2.pdf", b64: b64(tinyPdf([PARA], meta)) }]);
    expect(out).toContain("## Text layer\n\nExtracted at the door from `2602.07267v2.pdf` — 1 page.\n\nLine 1 of a real paper");
    expect(out).toContain('title: "BRIDGE: Predicting Human Task Completion Time"');
    expect(out).not.toContain("2602.07267v2.pdf\"\n"); // the tab title is gone
    expect(out).toContain("pages: 1");
    expect(out).toContain('author: "Liu; Gala"'); // yscalar quotes the semicolon
    expect(out).toContain("url: https://arxiv.org/pdf/2602.07267v2");
    expect(out).toContain("kind: pdf-import");
    expect(out).toContain("its text was not extracted at capture time.");
    // the frontmatter block is still one well-formed block
    expect(out.startsWith("---\n")).toBe(true);
    expect(out.split("\n---\n").length).toBe(2);
  });

  test("`kind: pdf` (a bare `bigbrain drop paper.pdf`) is a stub too", async () => {
    const cli = "---\nsource: cli\nkind: pdf\ntitle: paper\ndate: 2026-08-28T00:00:00.000Z\n---\n\nDropped file: paper.pdf (1234 bytes)\n";
    const out = await discussablePdf(cli, [{ name: "paper.pdf", b64: b64(tinyPdf([PARA], meta)) }]);
    expect(out).toContain("## Text layer");
    expect(out).toContain('title: "BRIDGE: Predicting Human Task Completion Time"');
    expect(out).toContain("date: 2026-08-28T00:00:00.000Z"); // present → untouched
  });

  test("a client that already delivered text (the web drop zone) is left byte-identical", async () => {
    const dropZone = `---\nsource: web-drop\nkind: pdf-import\ntitle: paper\npages: 1\n---\n\n${PARA}\n\n${PARA}\n`;
    const out = await discussablePdf(dropZone, [{ name: "paper.pdf", b64: b64(tinyPdf([PARA], meta)) }]);
    expect(out).toBe(dropZone);
  });

  test("another kind with a PDF riding along is not the door's business", async () => {
    const clip = "---\nkind: web-clip\ntitle: some page\n---\n\nshort\n";
    expect(await discussablePdf(clip, [{ name: "a.pdf", b64: b64(tinyPdf([PARA], meta)) }])).toBe(clip);
    expect(await discussablePdf(STUB, [])).toBe(STUB);
    expect(await discussablePdf(STUB, undefined)).toBe(STUB);
  });

  test("a document's own title is kept (Firefox's tab title IS the metadata title)", async () => {
    const firefox = STUB.replace('title: "BRIDGE paper - 2602.07267v2.pdf"', "title: The Client Knew Better");
    const out = await discussablePdf(firefox, [{ name: "2602.07267v2.pdf", b64: b64(tinyPdf([PARA], meta)) }]);
    expect(out).toContain("title: The Client Knew Better");
    expect(out).not.toContain("BRIDGE: Predicting");
    expect(out).toContain("## Text layer");
  });

  test("garbage metadata titles never replace a filename", async () => {
    for (const Title of ["Microsoft Word - paper.docx", "untitled", "paper.tex", "short", "2602.07267"]) {
      const out = await discussablePdf(STUB, [{ name: "2602.07267v2.pdf", b64: b64(tinyPdf([PARA], { Title })) }]);
      expect(out).toContain('title: "BRIDGE paper - 2602.07267v2.pdf"');
      expect(out).toContain("## Text layer");
    }
  });

  test("a scanned document gets the honest note and no text section", async () => {
    const out = await discussablePdf(STUB, [{ name: "scan.pdf", b64: b64(tinyPdf(["x", "y"])) }]);
    expect(out).toContain("> Near-empty text layer (2 pages) — likely a scanned or image-only PDF");
    expect(out).not.toContain("## Text layer");
    expect(out).toContain("pages: 2");
  });

  test("an unreadable PDF lands as the stub it arrived as — never a failed landing", async () => {
    const out = await discussablePdf(STUB, [{ name: "broken.pdf", b64: b64(Buffer.from("%PDF-1.4 minimal")) }]);
    expect(out).toBe(STUB);
  });

  test("the first PDF attachment is the document; a non-PDF ahead of it is skipped", async () => {
    const out = await discussablePdf(STUB, [
      { name: "cover.png", b64: b64(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
      { name: "real.pdf", b64: b64(tinyPdf([PARA], meta)) },
    ]);
    expect(out).toContain("Extracted at the door from `real.pdf`");
  });
});
