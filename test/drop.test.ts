import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_ROOT } from "../lib/engine";
import { looksBinary } from "../lib/intake";
import { readBlob } from "../lib/blobs";
import { readSourceInsertionLog } from "../lib/insertionLog";
import { createHash } from "node:crypto";

// ══════════════════════════════════════════════════════════════════════
// looksBinary — the #57 gate that keeps `drop paper.pdf` from the mangle
// ══════════════════════════════════════════════════════════════════════
describe("looksBinary", () => {
  const empty = new Uint8Array(0);
  test("known attachment extensions win regardless of bytes", () => {
    expect(looksBinary("paper.pdf", empty)).toBe(true);
    expect(looksBinary("photo.JPG", empty)).toBe(true);
    expect(looksBinary("diagram.svg", new TextEncoder().encode("<svg/>"))).toBe(true);
    expect(looksBinary("call.m4a", empty)).toBe(true);
    expect(looksBinary("bundle.zip", empty)).toBe(true);
  });
  test("known text extensions win regardless of bytes", () => {
    expect(looksBinary("note.md", new Uint8Array([0, 1, 2]))).toBe(false);
    expect(looksBinary("todo.txt", new Uint8Array([0]))).toBe(false);
  });
  test("unknown extensions sniff for null bytes", () => {
    expect(looksBinary("data.bin", new Uint8Array([104, 105, 0, 104]))).toBe(true);
    expect(looksBinary("notes.rst", new TextEncoder().encode("plain prose"))).toBe(false);
    expect(looksBinary("no-extension", new TextEncoder().encode("also prose"))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// bin/drop.ts — binary lands as CAS blob + envelope reference
// ══════════════════════════════════════════════════════════════════════
function hostVault(): string {
  const root = mkdtempSync(join(tmpdir(), "bb-drop-"));
  mkdirSync(join(root, ".state"), { recursive: true });
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "vault.yaml"), "integrations: {}\n");
  return root;
}

/** The landed item as the record holds it: the insertion event's envelope
 * over its body. The gitignored desk copy under inbox/ went on 2026-08-30. */
const landed = (root: string): string => {
  const [e] = readSourceInsertionLog(root);
  if (!e) throw new Error("nothing landed");
  return `${Object.entries(e.envelope).map(([k, v]) => `${k}: ${v as string}`).join("\n")}\n\n${e.body}\n`;
};

const runDrop = (root: string, args: string[], stdin?: Buffer) =>
  spawnSync("bun", [join(ENGINE_ROOT, "bin", "drop.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, BIGBRAIN_VAULT: root },
    ...(stdin ? { input: stdin } : {}),
  });

// A tiny real-shaped PDF: magic header + a null byte, so both the extension
// gate and the sniff would catch it.
const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.4\n"),
  Buffer.from([0, 1, 2, 3]),
  Buffer.from("\n%%EOF\n"),
]);

describe("bin/drop.ts — binary files (#57)", () => {
  test("a bare PDF drop lands bytes in the CAS and an insertion linking blob:<sha>", () => {
    const root = hostVault();
    const src = join(root, "paper.pdf");
    writeFileSync(src, PDF_BYTES);

    const r = runDrop(root, [src]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/drop: landed at log\/insertions\//);
    expect(r.stdout).toContain("(source ");

    // original bytes, byte-identical, under their own sha
    const sha = createHash("sha256").update(PDF_BYTES).digest("hex");
    expect(readBlob(root, sha)?.equals(PDF_BYTES)).toBe(true);

    // the landed item: envelope from the filename + the blob link
    const item = landed(root);
    expect(item).toContain("kind: pdf");
    expect(item).toContain("title: paper");
    expect(item).toContain(`[paper.pdf](blob:${sha})`);
    // and never the mangle: no raw PDF bytes in the item text
    expect(item).not.toContain("%PDF");
  });

  test("a text drop with --attach carries the file alongside the note", () => {
    const root = hostVault();
    const note = join(root, "note.md");
    writeFileSync(note, "---\ntitle: reading notes\n---\n\nsee attached\n");
    const fig = join(root, "fig.png");
    const figBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]);
    writeFileSync(fig, figBytes);

    const r = runDrop(root, [note, "--attach", fig]);
    expect(r.status).toBe(0);

    const sha = createHash("sha256").update(figBytes).digest("hex");
    expect(readBlob(root, sha)?.equals(figBytes)).toBe(true);
    const item = landed(root);
    expect(item).toContain("see attached");
    expect(item).toContain(`![fig.png](blob:${sha})`); // image attachments embed
  });

  test("a missing --attach file refuses before anything ships", () => {
    const root = hostVault();
    const note = join(root, "note.md");
    writeFileSync(note, "body\n");
    const r = runDrop(root, [note, "--attach", join(root, "nope.pdf")]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no such file");
  });

  test("text drops still land verbatim (the old contract)", () => {
    const root = hostVault();
    const note = join(root, "idea.md");
    writeFileSync(note, "just a thought\n");
    const r = runDrop(root, [note]);
    expect(r.status).toBe(0);
    expect(landed(root)).toContain("just a thought");
  });
});
