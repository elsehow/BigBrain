/**
 * lib/run/journal.ts's readQueueJournalFile — the one typed reader
 * replacing three ad-hoc JSON.parse(readFileSync(...)) sites (#265):
 * lib/api.ts's /v1/status.last_run, lib/noteLog.ts's runRole/journalModelFor/
 * journalLogRows.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQueueJournalFile } from "../lib/run/journal";

const scratch = () => mkdtempSync(join(tmpdir(), "bb-journal-reader-"));

describe("readQueueJournalFile", () => {
  test("a well-formed record: raw text AND the typed record both come back", () => {
    const dir = scratch();
    const f = join(dir, "run-1.json");
    const record = { run: "run-1", startedAt: "2026-01-01T00:00:00Z", model: "opus", wallMs: 42 };
    writeFileSync(f, JSON.stringify(record));
    const got = readQueueJournalFile(f);
    expect(got?.record).toEqual(record);
    expect(got?.raw).toBe(JSON.stringify(record));
  });

  test("missing file → undefined, not a throw", () => {
    const dir = scratch();
    expect(readQueueJournalFile(join(dir, "nope.json"))).toBeUndefined();
  });

  test("corrupt/truncated JSON → undefined, not a throw", () => {
    const dir = scratch();
    const f = join(dir, "bad.json");
    writeFileSync(f, '{"run": "x", "started');
    expect(() => readQueueJournalFile(f)).not.toThrow();
    expect(readQueueJournalFile(f)).toBeUndefined();
  });

  test("valid JSON but not an object (e.g. a bare string) → undefined", () => {
    const dir = scratch();
    const f = join(dir, "scalar.json");
    writeFileSync(f, '"just a string"');
    expect(readQueueJournalFile(f)).toBeUndefined();
  });

  test("a legacy pre-#263 record (lane/verb, no engine/auth) round-trips untouched", () => {
    const dir = scratch();
    const f = join(dir, "legacy.json");
    const record = { lane: "fast", verb: "filed", startedAt: "2026-01-01T00:00:00Z" };
    writeFileSync(f, JSON.stringify(record));
    expect(readQueueJournalFile(f)?.record).toEqual(record);
  });
});
