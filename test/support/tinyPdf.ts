// tinyPdf — a hand-built PDF for the extraction tests (pdfText, pdfFills):
// no fixture file to go stale, every byte accounted for.

/** A minimal, spec-correct PDF: one Helvetica text object per page, an
 * Info dictionary, a real xref table (pdf.js would reconstruct a broken
 * one, but a fixture should not lean on that). */
export function tinyPdf(pages: string[], info: Record<string, string> = {}): Buffer {
  const objs: string[] = [];
  const pageIds: number[] = [];
  // 1 catalog, 2 pages, 3 font, then per page: page + content stream
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("PAGES");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const text of pages) {
    const lines = text.split("\n");
    const ops = lines.map((l, i) => `${i ? "0 -28 Td " : ""}(${l.replace(/[()\\]/g, "\\$&")}) Tj`).join("\n");
    const stream = `BT /F1 20 Tf 72 720 Td\n${ops}\nET`;
    const pageId = objs.length + 1;
    pageIds.push(pageId);
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`
    );
    objs.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  const infoId = objs.length + 1;
  objs.push(`<< ${Object.entries(info).map(([k, v]) => `/${k} (${v})`).join(" ")} >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
