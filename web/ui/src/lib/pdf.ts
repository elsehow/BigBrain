// pdf.ts — extract a dropped PDF's text layer in the browser, so the vault
// receives markdown through the same intake waist as every other
// integration. Same philosophy as the extension's extract.js: CAPTURE,
// don't interpret — the text layer is shipped faithfully (page order, line
// breaks from the layout engine), and judgment about what it means belongs
// to triage. A scanned/image-only PDF has almost no text layer; we report
// that honestly rather than shipping nothing silently.

type StreamProto = { [Symbol.asyncIterator]?: unknown; values?: unknown };

/**
 * WebKit has no async iteration on ReadableStream — neither
 * `Symbol.asyncIterator` nor `values()` (bugs.webkit.org 194379, open since
 * 2019; still absent in the WebKit of macOS 26.6). pdf.js 6's getTextContent
 * is `for await (const value of readableStream)`, so in the desktop app's
 * WKWebView every PDF drop died as "undefined is not a function (near
 * '...i of e...')" — Nick, 2026-09-03, a PDF from the Finder. This is the
 * spec's shape (read until done; an early exit cancels the stream unless
 * preventCancel), installed only where it is missing, before pdf.js loads.
 * The worker has its own `for await`, over a DecompressionStream, but only
 * under image decoding, which text extraction never reaches.
 */
export function ensureStreamAsyncIteration(proto: StreamProto = ReadableStream.prototype as StreamProto): boolean {
  if (typeof proto[Symbol.asyncIterator] === "function") return false;
  async function* values(this: ReadableStream, opts?: { preventCancel?: boolean }): AsyncGenerator<unknown> {
    const reader = this.getReader();
    let done = false;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) {
          done = true;
          return;
        }
        yield r.value;
      }
    } finally {
      if (!done && !opts?.preventCancel) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  // non-enumerable, like the built-ins they stand in for
  const define = (key: PropertyKey): void => {
    Object.defineProperty(proto, key, { value: values, writable: true, configurable: true, enumerable: false });
  };
  if (typeof proto.values !== "function") define("values");
  define(Symbol.asyncIterator);
  return true;
}

/**
 * pdf.js's LEGACY build, on purpose. The default build uses the newest
 * language features unguarded — `Map.prototype.getOrInsertComputed` (the
 * 2025 "upsert" methods) in getMetadata and every cached document method,
 * and in the worker under fonts, dictionaries and ciphers — and a WebKit
 * older than the one on macOS 26.6 has no such method, causing
 * "this.#e.getOrInsertComputed is not a function", after every page had
 * already extracted. The legacy build carries core-js fills for the
 * LANGUAGE (upsert, Promise.try, Float16Array, Uint8Array.fromBase64, …) in
 * both the main-thread module and the worker — where no fill of ours could
 * reach. 57kB more on the main module, 50kB on the worker, both loaded on
 * the first drop only, never in the viewer's main chunk. core-js fills the
 * language, not the platform: the stream fill above stays. When bumping
 * pdfjs-dist, keep both imports on `legacy/`.
 */
type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

async function loadPdfjs(): Promise<Pdfjs> {
  ensureStreamAsyncIteration();
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

export interface PdfExtract {
  text: string;
  pages: number;
  title: string;
  author: string;
  created: string; // ISO date or ""
  thin: boolean; // near-empty text layer — likely scanned
}

/** PDF date strings look like D:20260115093000-08'00'. Date part only —
 * time-of-day precision isn't worth the timezone parsing. */
function pdfDate(v: unknown): string {
  const m = typeof v === "string" && /^D:(\d{4})(\d{2})(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** The walk, over whichever pdf.js is loaded: the legacy build above in the
 * browser; the same build in Bun for test/pdfFills.test.ts, with the methods
 * an older WebKit lacks deleted first. */
export async function extractPdfWith(pdfjs: Pick<Pdfjs, "getDocument">, data: ArrayBuffer | Uint8Array): Promise<PdfExtract> {
  const doc = await pdfjs.getDocument({ data }).promise;
  const pageTexts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str;
      text += item.hasEOL ? "\n" : " ";
    }
    pageTexts.push(
      text
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    );
  }
  // Metadata is the optional part — the text is the payload and the title
  // has the filename to fall back on. getMetadata is a plain method that
  // returns a promise, so a throw on the way to the promise (the compatibility failure above)
  // escapes a bare `.catch`; wrapped, either failure reads as "no metadata".
  const meta = await Promise.resolve()
    .then(() => doc.getMetadata())
    .catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  const text = pageTexts.filter(Boolean).join("\n\n---\n\n");
  return {
    text,
    pages: doc.numPages,
    title: typeof info["Title"] === "string" ? info["Title"].trim() : "",
    author: typeof info["Author"] === "string" ? info["Author"].trim() : "",
    created: pdfDate(info["CreationDate"]),
    thin: text.replace(/\s+/g, "").length < 200,
  };
}

export async function extractPdf(file: File): Promise<PdfExtract> {
  return extractPdfWith(await loadPdfjs(), await file.arrayBuffer());
}
