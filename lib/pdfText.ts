/**
 * lib/pdfText.ts — the door's PDF text layer.
 *
 * A PDF reaches the door as bytes plus a stub. The browser extension can't
 * read either engine's PDF viewer (a privileged page), so it re-fetches the
 * document and ships it as an attachment under one sentence of prose
 * (#63); `bigbrain drop paper.pdf` composes the same shape. The retired
 * editor pass extracted the text host-side with pdftotext (#58, duty 0) —
 * and retired with the pass (#498, #543). The gardener has only the
 * bigbrain tools: no shell, no blob resolver, and read_note refuses
 * `.blobs/`. So every PDF clipped since 2026-08-23 stayed a stub, while
 * preflight kept warning about a binary nothing called.
 *
 * Extraction now happens where design principle 3 puts it: at the door,
 * deterministically, before any model — the same text-layer walk the web
 * drop zone already runs in the browser (web/ui/src/lib/pdf.ts), done by
 * the host on landing for the clients that cannot. Pure JS (unpdf is
 * pdf.js's serverless build, ~2.5MB): it ships inside the app and runs the
 * same on every platform bun runs. No poppler, nothing for the user to
 * install — a text layer is what most PDFs already carry; OCR of scanned
 * pages is a different job and is NOT attempted (the thin note says so).
 *
 * The lake rule (#58) holds: the blob is the lossless original, the item
 * body is the door's lossy projection of it, and the lake is append-only —
 * a better extractor changes what future landings say, never past ones.
 * The dedup identity is the door's composed payload (lib/landItem.ts), so
 * a retry lands once while a re-clip after the extractor improved lands
 * the improved version beside the old stub — its only road to the text.
 */

import { getDocumentProxy } from "unpdf";
import { splitNote, yscalar } from "./fsx";
import { type Attachment, stripFmKeys } from "./intake";

export interface PdfText {
  text: string;
  pages: number;
  /** Pages actually walked — fewer than `pages` when `maxChars` stopped it. */
  pagesRead: number;
  title: string;
  author: string;
  /** ISO date (YYYY-MM-DD) from the PDF's CreationDate, or "". */
  created: string;
  /** Near-empty text layer — a scanned or image-only document. */
  thin: boolean;
}

/** Item TEXT rides git forever (lib/intake.ts MAX_BYTES caps it at 10MB);
 * a text layer stops well short of that. ~2M chars is 600+ dense pages. */
const PDF_TEXT_MAX_CHARS = 2_000_000;

/** Below this many non-whitespace characters, a text layer is noise (the
 * web drop zone's threshold — a scanned PDF yields a few stray glyphs). */
const THIN_CHARS = 200;

/** A body with fewer non-whitespace characters than this, once its blob
 * links and quoted warnings are set aside, is a STUB — the door's word for
 * "the client shipped bytes, not text". Anything longer is a client that
 * delivered its own discussable version (the web drop zone), left alone. */
const STUB_CHARS = 400;

/** `%PDF` within the first 1kB — the spec tolerates leading junk (the
 * extension's hasPdfMagic, same rule). */
export function isPdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 1024)).toString("latin1");
  return head.includes("%PDF");
}

/** PDF date strings look like D:20260115093000-08'00'. Date part only. */
function pdfDate(v: unknown): string {
  const m = typeof v === "string" && /^D:(\d{4})(\d{2})(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** Walk the text layer page by page. Faithful capture, no interpretation:
 * pdf.js's own line breaks, pages joined by a rule. Stops once `maxChars`
 * is exceeded (the rest is in the blob). Throws on an unreadable document
 * (encrypted, truncated, not a PDF) — the caller decides what that means. */
export async function extractPdfText(
  bytes: Uint8Array,
  opts: { maxChars?: number } = {}
): Promise<PdfText> {
  const maxChars = opts.maxChars ?? PDF_TEXT_MAX_CHARS;
  // Font faces are unnecessary for text extraction.
  // unpdf refuses a Node Buffer by name; a Uint8Array VIEW over the same
  // bytes is what it wants (no copy).
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const doc = await getDocumentProxy(data, { disableFontFace: true });
  const pageTexts: string[] = [];
  let total = 0;
  let pagesRead = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    if (total > maxChars) break;
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str;
      text += item.hasEOL ? "\n" : " ";
    }
    text = text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    pageTexts.push(text);
    total += text.length;
    pagesRead = i;
  }
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  const text = pageTexts.filter(Boolean).join("\n\n---\n\n").slice(0, maxChars);
  return {
    text,
    pages: doc.numPages,
    pagesRead,
    title: typeof info["Title"] === "string" ? info["Title"].trim() : "",
    author: typeof info["Author"] === "string" ? info["Author"].trim() : "",
    created: pdfDate(info["CreationDate"]),
    thin: text.replace(/\s+/g, "").length < THIN_CHARS,
  };
}

const KIND_PDF = /^kind:\s*["']?(pdf-import|pdf)["']?\s*$/m;
const FM_TITLE = /^title:\s*(.*?)\s*$/m;
const BLOB_LINE = /^!?\[[^\]]*\]\(blob:[0-9a-f]{64}\)\s*$/;

/** The stub test: prose that is not a blob link and not a quoted warning. */
function proseChars(body: string): number {
  return body
    .split("\n")
    .filter((l) => !BLOB_LINE.test(l.trim()) && !l.startsWith(">"))
    .join("")
    .replace(/\s+/g, "").length;
}

function unquote(v: string): string {
  const m = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v);
  if (!m) return v;
  try {
    return v.startsWith('"') ? (JSON.parse(v) as string) : m[1]!;
  } catch {
    return m[1]!;
  }
}

/** A client title that is only the file's name — a browser tab title for a
 * PDF (Chrome's is the filename, or the server's; Firefox's is the
 * document's own title, which does NOT match here and is kept), the CLI's
 * filename-sans-extension, a bare arXiv id. */
function filenameish(title: string, attachmentName: string): boolean {
  const t = title.trim();
  if (!t) return true;
  if (/\.pdf$/i.test(t)) return true;
  const stem = attachmentName.replace(/\.pdf$/i, "");
  if (t.toLowerCase() === stem.toLowerCase()) return true;
  return /^\d{4}\.\d{4,5}(v\d+)?$/.test(t);
}

/** PDF metadata titles are often garbage (the authoring tool's default, a
 * source filename). Accept only what reads as a real title. */
function saneTitle(t: string): boolean {
  const s = t.trim();
  if (s.length < 8 || s.length > 300) return false;
  if (/^(untitled|microsoft (word|powerpoint)|powerpoint presentation|slide 1)\b/i.test(s)) return false;
  if (/\.(docx?|tex|pdf|pptx?|indd|md|txt)$/i.test(s)) return false;
  return /[a-z]/i.test(s);
}

/** The door's composer: an item that is a PDF STUB — `kind: pdf-import`
 * (the extension, the web drop zone) or `kind: pdf` (`bigbrain drop
 * paper.pdf`) with no prose of its own — gets its text layer appended as
 * a `## Text layer` section, and the envelope gets what the document
 * knows about itself: a real `title` when the client's was only a
 * filename, `pages`, `author`, `date` (CreationDate) when absent. Every
 * other item — no attachments, another kind, a client that already
 * delivered text, a PDF the parser can't read — comes back BYTE-IDENTICAL,
 * and nothing here ever fails the landing: an unreadable document lands
 * as the stub it arrived as, with the reason on stderr. */
export async function discussablePdf(
  content: string,
  attachments: Attachment[] | undefined
): Promise<string> {
  if (!attachments?.length) return content;
  const { fm, body } = splitNote(content);
  if (!KIND_PDF.test(fm)) return content;
  if (proseChars(body) >= STUB_CHARS) return content;

  // Sniff the first kilobyte of each attachment before decoding any in
  // full — a drop can carry megabytes.
  const att = attachments.find((a) => isPdf(Buffer.from(a.b64.slice(0, 1400), "base64")));
  if (!att) return content;
  const name = att.name || "attachment.pdf";

  let ex: PdfText;
  try {
    ex = await extractPdfText(Buffer.from(att.b64, "base64"));
  } catch (e) {
    console.error(`pdf text layer: ${name}: ${e instanceof Error ? e.message : String(e)} — landing the stub`);
    return content;
  }

  let lines = fm ? fm.split("\n") : [];
  const has = (key: string): boolean => lines.some((l) => new RegExp(`^${key}\\s*:`).test(l));
  const clientTitle = unquote(FM_TITLE.exec(fm)?.[1] ?? "");
  if (filenameish(clientTitle, name) && saneTitle(ex.title)) {
    const stripped = stripFmKeys(fm, ["title"]);
    lines = stripped.trim() ? stripped.split("\n") : [];
    lines.push(`title: ${yscalar(ex.title)}`);
  }
  if (!has("pages")) lines.push(`pages: ${ex.pages}`);
  if (ex.author && !has("author")) lines.push(`author: ${yscalar(ex.author)}`);
  if (ex.created && !has("date")) lines.push(`date: ${ex.created}`);

  const trimmed = body.replace(/^\n+/, "").replace(/\s+$/, "");
  let section: string;
  if (ex.thin) {
    section =
      `> Near-empty text layer (${ex.pages} page${ex.pages === 1 ? "" : "s"}) — likely a scanned or ` +
      "image-only PDF; the attached original is the document.";
  } else {
    const partial = ex.pagesRead < ex.pages ? `, first ${ex.pagesRead}` : "";
    section =
      `## Text layer\n\nExtracted at the door from \`${name}\` — ${ex.pages} page${ex.pages === 1 ? "" : "s"}${partial}.\n\n` +
      ex.text;
  }
  return ["---", ...lines, "---", "", trimmed, "", section, ""].join("\n");
}
