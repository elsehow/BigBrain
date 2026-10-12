import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSourceInsertion } from "../lib/assertionProjection";
import { assertionGraphEvidenceCached, invalidateGraphCaches } from "../lib/graphCache";
import { documentLinkTexts, vaultRecord } from "../lib/vaultReadModel";
import { appendSourceInsertionEvent } from "../lib/insertionLog";
import { proseChars } from "../lib/text";
import { insertion } from "./support/vault";

test("headers and arrival identity live apart from bodies, and identity lookups use an index", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-projection-layout-"));
  try {
    const item = insertion({
      id: `ins_${"a".repeat(24)}`, source_id: "fixture-call",
      body: "A fabricated call: the orrery budget, then the repair schedule.",
      envelope: { kind: "transcript", source: "granola", sha256: "f".repeat(64), stream: "calls", key: "call-1", seq: 3 },
    });
    appendSourceInsertionEvent(root, item);
    projectSourceInsertion(root, item);
    const db = new Database(join(root, ".state", "assertions.db"), { readonly: true });
    try {
      const columns = (table: string) => (db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);
      // A header read never walks a body: no wide column sits in a header row.
      expect(columns("sources")).not.toContain("body");
      expect(columns("sources")).not.toContain("event_json");
      expect(columns("markdown_documents")).not.toContain("document_json");
      expect(JSON.parse((db.query("SELECT event_json FROM source_documents").get() as { event_json: string }).event_json)).toEqual(item);
      expect(db.query(`SELECT envelope_kind AS kind, envelope_source AS source, envelope_sha256 AS sha256,
        envelope_stream AS stream, envelope_key AS key, envelope_seq AS seq, prose_chars FROM sources`).get())
        .toEqual({ kind: "transcript", source: "granola", sha256: "f".repeat(64), stream: "calls", key: "call-1", seq: 3, prose_chars: proseChars(item.body) });
      const plan = (sql: string) => (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join("\n");
      expect(plan("SELECT insertion_id FROM sources WHERE envelope_sha256 = 'x'")).toContain("sources_sha256");
      expect(plan("SELECT insertion_id FROM sources WHERE envelope_stream = 'calls' AND envelope_key = 'call-1'")).toContain("sources_stream");
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a link's evidence lives apart from what it names: the graph's record reads targets, an evidence build the paragraph", () => {
  const root = mkdtempSync(join(tmpdir(), "bb-projection-links-"));
  try {
    const page = insertion({ id: `ins_${"c".repeat(24)}`, source_id: "fixture-page", title: "Orrery repair notes",
      body: "The brass escapement is the part that failed.\n\nSee [[Kestrel Books]] for the supplier, and the catalogue at [the shop](https://example.org/catalogue)." });
    const supplier = insertion({ id: `ins_${"d".repeat(24)}`, source_id: "fixture-supplier", title: "Kestrel Books", body: "A fabricated bookshop." });
    for (const item of [page, supplier]) { appendSourceInsertionEvent(root, item); projectSourceInsertion(root, item); }
    const db = new Database(join(root, ".state", "assertions.db"), { readonly: true });
    try {
      const links = JSON.parse((db.query("SELECT links_json FROM document_links WHERE path = ?").get(`source:${page.id}`) as { links_json: string }).links_json);
      expect(links).toEqual([{ target: "Kestrel Books", markdown: false }, { target: "https://example.org/catalogue", markdown: true }]);
      const texts = JSON.parse((db.query("SELECT texts_json FROM document_link_text WHERE path = ?").get(`source:${page.id}`) as { texts_json: string }).texts_json);
      expect(texts).toHaveLength(2);
      expect(texts[0]).toContain("for the supplier");
    } finally { db.close(); }
    expect(vaultRecord(root).documentLinks.get(`source:${page.id}`)!.links[0]).not.toHaveProperty("text");
    expect(documentLinkTexts(root).get(`source:${page.id}`)![0]).toContain("for the supplier");
    // the evidence build still hands each connection its paragraph
    invalidateGraphCaches(root);
    const { connections } = assertionGraphEvidenceCached(root);
    expect(connections.find((c) => c.from === `source:${page.id}` && c.to === `source:${supplier.id}`)?.evidence.text).toContain("for the supplier");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
