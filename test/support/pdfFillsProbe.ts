// pdfFillsProbe — run by test/pdfFills.test.ts in a child Bun, because it
// deletes built-ins: the methods an older WebKit lacks come off the
// prototypes first, then a pdf.js build is loaded and the viewer's walk
// (web/ui/src/lib/pdf.ts) runs over a tiny PDF. Prints one JSON line last.
//
//   bun test/support/pdfFillsProbe.ts legacy [path.pdf] — the build the viewer
//       ships: load it, walk the fixture (or that file), report
//   bun test/support/pdfFillsProbe.ts worker    — load the legacy WORKER module alone
//   bun test/support/pdfFillsProbe.ts standard  — load pdf.js's default build (the
//       control; it cannot walk anything under Bun — "DOMMatrix is not defined")
import { ensureStreamAsyncIteration, extractPdfWith } from "../../web/ui/src/lib/pdf";
import { tinyPdf } from "./tinyPdf";

const mode = process.argv[2] ?? "legacy";
const pdfPath = process.argv[3];
const dist = new URL("../../web/ui/node_modules/pdfjs-dist/", import.meta.url);
const build = (file: string): string => new URL(`${mode === "standard" ? "build" : "legacy/build"}/${file}`, dist).href;

const strip = (o: object, key: PropertyKey): void => {
  delete (o as Record<PropertyKey, unknown>)[key];
};
const shape = (): Record<string, string> => ({
  map: typeof (Map.prototype as Record<string, unknown>)["getOrInsertComputed"],
  weakmap: typeof (WeakMap.prototype as Record<string, unknown>)["getOrInsertComputed"],
});

// Bun 1.3 has both upsert methods; take them away so the build under test
// has to bring its own. (The stream gap of #715 is not simulated here —
// Bun's ReadableStream methods are non-configurable; test/pdfStream.test.ts
// covers that fill on a bare prototype.)
for (const proto of [Map.prototype, WeakMap.prototype]) {
  strip(proto, "getOrInsertComputed");
  strip(proto, "getOrInsert");
}
const before = shape();

const out: Record<string, unknown> = { mode, before };
try {
  ensureStreamAsyncIteration();
  const pdfjs = await import(build(mode === "worker" ? "pdf.worker.mjs" : "pdf.mjs"));
  if (mode === "legacy") {
    pdfjs.setVerbosityLevel?.(pdfjs.VerbosityLevel?.ERRORS ?? 0);
    const buf = pdfPath
      ? await Bun.file(pdfPath).bytes()
      : tinyPdf(["Page one of the fixture.", "Page two of the fixture."], {
          Title: "Fixture",
          Author: "Dana",
          CreationDate: "D:20260903120000-07'00'",
        });
    // pdf.js refuses a Buffer by name; the viewer hands it an ArrayBuffer.
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const ex = await extractPdfWith(pdfjs, data);
    Object.assign(out, ex, pdfPath ? { text: `${ex.text.length} chars: ${ex.text.slice(0, 80).replace(/\s+/g, " ")}…` } : {});
  }
  out["ok"] = true;
} catch (e) {
  out["ok"] = false;
  out["error"] = e instanceof Error ? e.message : String(e);
}
out["after"] = shape();
console.log(JSON.stringify(out));
