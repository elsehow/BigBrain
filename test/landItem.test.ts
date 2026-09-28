import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { landDirective, landDrop } from "../lib/landItem";
import { landedText } from "./support/landed";
import { mdVault } from "./support/vault";

// Pins the one stamp → land → read-back path (#259) that all four HTTP
// landing doors now compose from: /v1/drop, /v1/enqueue (lib/api.ts) and
// /api/drop, /api/enqueue (web/server.ts). The doors' own tests pin the wire
// shapes; these pin the shared sequence directly.

const vault = (): string => mdVault({ prefix: "bb-landitem-", dirs: ["inbox"] });

describe("landDrop", () => {
  test("no stamp (inside the trust boundary): lands as composed, receipt carries the reference id", async () => {
    const root = vault();
    const r = await landDrop({ root, content: "---\nid: d-1\ntitle: T\n---\nbody\n" });
    expect(r.path).toMatch(/^log\/insertions\//);
    expect(r.id).toBe("d-1");
    expect(landedText(root, r)).toContain("body");
  });

  test("a stamp writes the credential's provenance; the PRE-stamp bytes stay the dedup identity", async () => {
    const root = vault();
    const stamp = { tokenId: "tok1", tokenName: "laptop", now: new Date("2026-08-13T12:00:00Z") };
    const a = await landDrop({ root, content: "same payload\n", stamp });
    expect(landedText(root, a)).toContain("submitted_by: tok1");
    // a byte-identical redelivery — stamped with a DIFFERENT received time —
    // still dedups to the original's id
    const b = await landDrop({
      root,
      content: "same payload\n",
      stamp: { ...stamp, now: new Date("2026-08-13T13:00:00Z") },
    });
    expect(b.id).toBe(a.id);
  });

  test("an id is minted when the client sent none — the client never has to", async () => {
    const root = vault();
    const r = await landDrop({
      root,
      content: "no frontmatter at all",
      stamp: { tokenId: "t", tokenName: "n" },
    });
    expect(r.id).toMatch(/^api-\d{4}-/);
  });
});

describe("landDrop — a PDF stub gets its text layer at the door (lib/pdfText.ts)", () => {
  // The smallest PDF with a text layer big enough not to read as scanned.
  function pdf(): Buffer {
    const text = Array.from({ length: 8 }, (_, i) => `(Line ${i + 1} of a paper about forecasting and horizons.) Tj 0 -28 Td`).join("\n");
    const stream = `BT /F1 20 Tf 72 720 Td\n${text}\nET`;
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Title (A Paper With A Real Title) >>",
    ];
    let out = "%PDF-1.4\n";
    const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const x = out.length;
    out += `xref\n0 7\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${x}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
  const stub =
    "---\nfrom: send-to-bigbrain\nfrom_kind: agent\ntitle: paper.pdf\nfilename: paper.pdf\nkind: pdf-import\n---\n\n" +
    "Captured from the browser's PDF viewer. The document rides as the attachment below; its text was not extracted at capture time.\n";
  const stamp = { tokenId: "tok1", tokenName: "chrome extension", now: new Date("2026-08-28T21:05:05Z") };

  test("the landed item carries the text layer, the real title, the stamp AND the blob link", async () => {
    const root = vault();
    const r = await landDrop({ root, content: stub, stamp, attachments: [{ name: "paper.pdf", b64: pdf().toString("base64") }] });
    const item = landedText(root, r);
    expect(item).toContain("## Text layer");
    expect(item).toContain("Line 1 of a paper about forecasting");
    expect(item).toContain("title: A Paper With A Real Title");
    expect(item).toContain("submitted_via: chrome extension");
    expect(item).toMatch(/\[paper\.pdf\]\(blob:[0-9a-f]{64}\)/);
  });

  test("a byte-identical redelivery (retry, double-click) lands once — the composed payload is the dedup identity", async () => {
    const root = vault();
    const att = [{ name: "paper.pdf", b64: pdf().toString("base64") }];
    const a = await landDrop({ root, content: stub, stamp, attachments: att });
    const b = await landDrop({ root, content: stub, stamp: { ...stamp, now: new Date("2026-08-28T22:00:00Z") }, attachments: att });
    expect(b.id).toBe(a.id);
  });
});

describe("landDirective (#521 — a voice arrival, not a queue message)", () => {
  test("lands an insertion event: refs canonicalize into about, identity rides the envelope", async () => {
    const root = vault();
    const clip = await landDrop({ root, content: "---\nid: d-1\ntitle: T\n---\nbody\n" });
    const r = landDirective(
      root,
      { refs: [clip.id!], guidance: "merge these" },
      { from: "nick@example.com", via: "web-edge", from_kind: "person" }
    );
    expect(r.path).toMatch(/^log\/insertions\//);
    expect(r.id).toMatch(/^ins_/);
    const event = JSON.parse(readFileSync(join(root, r.path), "utf8"));
    expect(event.id).toBe(r.id);
    expect(event.body).toBe("merge these");
    expect(event.envelope.kind).toBe("directive");
    expect(event.envelope.about).toEqual(["d-1"]);
    expect(event.envelope.from).toBe("nick@example.com");
    expect(event.envelope.from_kind).toBe("person");
  });

  test("a contract violation throws — the door's 400, not a half-landing", () => {
    const root = vault();
    // bad principal
    expect(() => landDirective(root, { guidance: "x" }, { from: "", via: "" })).toThrow();
    // a ref the record does not hold refuses the landing (#521's orphan guard)
    expect(() =>
      landDirective(root, { refs: ["r-nope"], guidance: "x" }, { from: "n", via: "web" })
    ).toThrow(/names nothing/);
  });
});
