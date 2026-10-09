import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { putBlob } from "../lib/blobs";
import { sha256hex } from "../lib/hash";
import { insertionEventRel } from "../lib/insertionLog";
import { handleVaultTool } from "../lib/vaultTools";
import { tinyPdf } from "./support/tinyPdf";
import { insertion, nativeVault } from "./support/vault";

const roots: string[] = [];
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));

const PAGE = Array.from({ length: 8 }, (_, i) => `Line ${i + 1}: the orrery moon train runs a 3:1 reduction.`).join("\n");
type Read = { title: string; markdown: string; attachment: { sha256: string; pages: number; pages_read: number; thin: boolean }; provenance: { trusted: boolean } };

/** A vault with one clipped PDF that landed as a stub, linking `other` files too. */
function clipped(other: Record<string, Buffer> = {}) {
  const files: Record<string, Buffer> = { "Orrery gearing.pdf": tinyPdf([PAGE, "Appendix: the sun gear has 24 teeth."]), ...other };
  const links = Object.entries(files).map(([name, bytes]) => `[${name}](blob:${sha256hex(bytes)})`);
  const clip = insertion({ id: `ins_${"d".repeat(24)}`, title: "Orrery gearing.pdf", body: [`Saved from the web: ${links[0]}`, ...links.slice(1)].join("\n\n"),
    envelope: { id: "src-d", kind: "pdf-import", source: "api", url: "https://orrery.example/gearing.pdf" } });
  const root = nativeVault({ insertions: [clip] }); roots.push(root);
  for (const bytes of Object.values(files)) putBlob(root, bytes);
  return { root, path: insertionEventRel(clip), pdf: sha256hex(files["Orrery gearing.pdf"]!) };
}
const read = (root: string, args: Record<string, unknown>, via: "cli" | "gardener" = "cli") => handleVaultTool({ root, via }, "read_note", args) as Promise<Read>;

test("read_note reads a PDF the note links as its text, under the note's title, fenced as the note's outside material", async () => {
  const { root, path, pdf } = clipped();
  const note = await read(root, { path, attachment: "Orrery gearing.pdf" });
  expect(note.title).toBe("Orrery gearing.pdf");
  expect(note.attachment).toEqual({ sha256: pdf, pages: 2, pages_read: 2, thin: false });
  expect(note.provenance.trusted).toBe(false);
  expect(note.markdown).toStartWith("<untrusted-data");
  expect(note.markdown).toContain("Line 8: the orrery moon train runs a 3:1 reduction.");
  expect(note.markdown).toContain("the sun gear has 24 teeth");
  expect(note.markdown).not.toContain("Saved from the web");
  // by its blob target too, windowed like any note
  const windowed = await read(root, { path, attachment: `blob:${pdf}`, q: "sun gear", slack: 0 });
  expect(windowed.markdown).toContain("_Windowed: 1 of");
  expect(windowed.markdown).toContain("24 teeth");
  expect(windowed.markdown).not.toContain("Line 1:");
  const sliced = await read(root, { path, attachment: "Orrery gearing.pdf", chars: 20 }) as Read & { truncated: boolean };
  expect(sliced.truncated).toBe(true);
  // the gardener reads the record raw
  expect((await read(root, { path, attachment: "Orrery gearing.pdf" }, "gardener")).markdown).toStartWith("Line 1:");
});

test("only a PDF the note links is read, and a refusal names what it links without its outside names", async () => {
  const { root, path, pdf } = clipped({ "notes.txt": Buffer.from("plain text, not a PDF"), "scan.pdf": tinyPdf(["x", "y"]) });
  const other = putBlob(root, tinyPdf(["A PDF no note links."])).sha256;
  await expect(read(root, { path, attachment: `blob:${other}` })).rejects.toThrow(`links no attachment "blob:${other}"; it links blob:${pdf}, blob:`);
  await expect(read(root, { path, attachment: "Gearing" })).rejects.toThrow(/it links blob:[0-9a-f]{64}, blob:/);
  await expect(read(root, { path, attachment: "notes.txt" })).rejects.toThrow(/^blob:[0-9a-f]{64} is not a PDF/);
  const scan = await read(root, { path, attachment: "scan.pdf" });
  expect(scan.attachment.thin).toBe(true);
  expect(scan.markdown).toContain("likely a scanned or image-only PDF");
  await expect(read(root, { path: "references/missing.md", attachment: "x.pdf" })).rejects.toThrow();
});
