/**
 * The drop body is assembled as a Blob of small pieces, never one string —
 * the fix for a ~500MB screen recording dying client-side with "allocation
 * size overflow" (btoa over the whole binary, then JSON.stringify copying
 * it again). The XHR that carries it is untestable here; the encoding is:
 * whatever the slicing does, the wire bytes must parse as the same JSON the
 * old single-string path produced.
 */

import { describe, expect, test } from "bun:test";
import { dropBody } from "../web/ui/src/lib/api";

async function parsed(
  body: Blob
): Promise<{ name?: string; content?: string; attachments?: { name: string; b64: string }[] }> {
  return JSON.parse(await body.text());
}

const bytesOf = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, "base64"));

describe("dropBody", () => {
  test("no attachments — plain JSON, byte-for-byte what stringify says", async () => {
    const body = await dropBody("note.md", "---\nid: x\n---\nhello");
    expect(body.type.startsWith("application/json")).toBe(true); // Bun appends ;charset=utf-8, browsers don't
    expect(await body.text()).toBe(
      JSON.stringify({ name: "note.md", content: "---\nid: x\n---\nhello" })
    );
  });

  test("attachment names and content with JSON-hostile characters survive", async () => {
    // The name is stringified properly; the base64 is spliced raw between
    // quotes — this only works because base64 needs no JSON escaping.
    const data = new Blob([new Uint8Array([0, 1, 2])]);
    const j = await parsed(
      await dropBody('we"ird\n.md', 'quote " backslash \\ done', [
        { name: 'sp"ooky\\.bin', file: data },
      ])
    );
    expect(j.name).toBe('we"ird\n.md');
    expect(j.content).toBe('quote " backslash \\ done');
    expect(j.attachments?.[0]?.name).toBe('sp"ooky\\.bin');
  });

  test("an attachment spanning several slices decodes to the exact original bytes", async () => {
    // Bigger than one 1.5MB slice, and NOT a multiple of 3, so the final
    // slice ends in real padding. Each earlier slice is a multiple of 3 —
    // that is the invariant that lets the parts concatenate: a padded '='
    // mid-stream would corrupt everything after it.
    const size = 4 * 1024 * 1024 + 1;
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i++) original[i] = (i * 31 + 7) & 0xff;
    const j = await parsed(
      await dropBody("clip.md", "---\n---\n", [{ name: "clip.mov", file: new Blob([original]) }])
    );
    expect(bytesOf(j.attachments![0]!.b64)).toEqual(original);
  });

  test("several attachments ride one body, each intact", async () => {
    const a = new Uint8Array([255, 0, 128]);
    const b = new Uint8Array([1, 2]); // length not a multiple of 3 — padding on a tiny file
    const j = await parsed(
      await dropBody("two.md", "x", [
        { name: "a.bin", file: new Blob([a]) },
        { name: "b.bin", file: new Blob([b]) },
      ])
    );
    expect(j.attachments).toHaveLength(2);
    expect(bytesOf(j.attachments![0]!.b64)).toEqual(a);
    expect(bytesOf(j.attachments![1]!.b64)).toEqual(b);
  });

  test("empty attachment list means NO attachments key — the wire shape the server dedups on", async () => {
    const j = await parsed(await dropBody("empty.md", "x", []));
    expect("attachments" in j).toBe(false);
  });

  test("onEncode reports cumulative file bytes across ALL attachments, ending exactly at the total", async () => {
    // The encode leg is what the card labels "preparing N%" — it must climb
    // monotonically and land on the summed size, or the bar lies.
    const a = new Uint8Array(2 * 1024 * 1024 + 5); // spans slices, not a multiple of 3
    const b = new Uint8Array(3);
    const seen: [number, number][] = [];
    await dropBody(
      "clip.md",
      "x",
      [
        { name: "a.bin", file: new Blob([a]) },
        { name: "b.bin", file: new Blob([b]) },
      ],
      (done, total) => seen.push([done, total])
    );
    expect(seen.length).toBeGreaterThan(1); // more than one slice → more than one tick
    for (const [, total] of seen) expect(total).toBe(a.length + b.length);
    for (let i = 1; i < seen.length; i++) expect(seen[i]![0]).toBeGreaterThan(seen[i - 1]![0]);
    expect(seen.at(-1)![0]).toBe(a.length + b.length);
  });
});
