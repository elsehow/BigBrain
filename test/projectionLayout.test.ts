import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSourceInsertion } from "../lib/assertionProjection";
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
