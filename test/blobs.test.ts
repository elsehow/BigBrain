import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteBlob, getBlobPath, hasBlob, parseBlobRef, putBlob, readBlob } from "../lib/blobs";

const freshRoot = () => mkdtempSync(join(tmpdir(), "bb-blobs-"));
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("blobs (private CAS)", () => {
  test("put/get/read/delete round-trip", () => {
    const root = freshRoot();
    const bytes = new TextEncoder().encode("hello lake");
    const put = putBlob(root, bytes);

    expect(put.sha256).toBe(sha256hex("hello lake"));
    expect(put.bytes).toBe(bytes.byteLength);
    expect(put.existed).toBe(false);

    const path = getBlobPath(root, put.sha256);
    expect(path).not.toBeNull();
    expect(path).toBe(join(root, ".blobs", "sha256", put.sha256.slice(0, 2), put.sha256));
    expect(hasBlob(root, put.sha256)).toBe(true);
    expect(readBlob(root, put.sha256)?.toString()).toBe("hello lake");

    expect(deleteBlob(root, put.sha256)).toBe(true);
    expect(hasBlob(root, put.sha256)).toBe(false);
    expect(getBlobPath(root, put.sha256)).toBeNull();
    expect(readBlob(root, put.sha256)).toBeNull();
  });

  test("get/has/read on an absent hash is a plain miss, not a throw", () => {
    const root = freshRoot();
    const missing = sha256hex("never written");
    expect(getBlobPath(root, missing)).toBeNull();
    expect(hasBlob(root, missing)).toBe(false);
    expect(readBlob(root, missing)).toBeNull();
    expect(deleteBlob(root, missing)).toBe(false);
  });

  test("dedup: identical bytes written twice report existed on the second put", () => {
    const root = freshRoot();
    const bytes = new TextEncoder().encode("same content");
    const first = putBlob(root, bytes);
    const second = putBlob(root, bytes);

    expect(first.existed).toBe(false);
    expect(second.existed).toBe(true);
    expect(second.sha256).toBe(first.sha256);

    // exactly one file on disk for this hash — no duplicate write happened
    const dir = join(root, ".blobs", "sha256", first.sha256.slice(0, 2));
    expect(readdirSync(dir)).toEqual([first.sha256]);
  });

  test("different bytes with the same content produce the same hash and dir", () => {
    const root = freshRoot();
    const a = putBlob(root, new TextEncoder().encode("shared"));
    const b = putBlob(root, Buffer.from("shared"));
    expect(a.sha256).toBe(b.sha256);
    expect(b.existed).toBe(true);
  });

  test("rejects malformed sha256 inputs — path-traversal guard", () => {
    const root = freshRoot();
    const bad = [
      "../../../etc/passwd",
      "..",
      "abc",
      "g".repeat(64), // non-hex char
      "A".repeat(64), // uppercase not accepted
      "0".repeat(63), // too short
      "0".repeat(65), // too long
      "0".repeat(64) + "/../../evil",
      "",
      "0".repeat(62) + "/x",
    ];
    for (const sha256 of bad) {
      expect(() => getBlobPath(root, sha256)).toThrow();
      expect(() => deleteBlob(root, sha256)).toThrow();
    }
  });

  test("atomicity smoke: no partial/temp files remain after a put", () => {
    const root = freshRoot();
    const put = putBlob(root, new TextEncoder().encode("atomic write"));
    const dir = join(root, ".blobs", "sha256", put.sha256.slice(0, 2));
    const entries = readdirSync(dir);
    expect(entries).toEqual([put.sha256]);
    expect(entries.some((f) => f.startsWith(".tmp-"))).toBe(false);
  });
});

describe("parseBlobRef — the one blob-link representation (lib/envelope.ts)", () => {
  test("extracts the sha256 out of a well-formed ref", () => {
    const hash = sha256hex("hello lake");
    expect(parseBlobRef(`blob:${hash}`)).toBe(hash);
  });
  test("a real vault-relative path is not a blob ref", () => {
    expect(parseBlobRef("inbox/attachments/pic/photo.png")).toBeNull();
  });
  test("uppercase hex, wrong length, or garbage all fail closed", () => {
    expect(parseBlobRef(`blob:${"A".repeat(64)}`)).toBeNull();
    expect(parseBlobRef(`blob:${"0".repeat(63)}`)).toBeNull();
    expect(parseBlobRef("blob:not-a-hash")).toBeNull();
    expect(parseBlobRef("")).toBeNull();
  });
});
