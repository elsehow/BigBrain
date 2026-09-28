import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSourceInsertion, insertionAuthor, readSourceInsertionLog, sourceMoment } from "../lib/insertionLog";
import { receive } from "../lib/intake";

const root = (): string => mkdtempSync(join(tmpdir(), "bb-insertion-log-"));

describe("native insertion log", () => {
  test("appends one deterministic immutable event and converges on retry", () => {
    const vault = root();
    const envelope = {
      id: "meeting-1", title: "Interpretability sync", date: "2026-08-15",
      received: "2026-08-16T10:00:00.000Z", from: "nick@example.com", from_kind: "person",
    };
    const first = appendSourceInsertion(vault, envelope, "Nick spoke with Ada.\n");
    const again = appendSourceInsertion(vault, envelope, "Nick spoke with Ada.\n");
    expect(first.deduped).toBe(false);
    expect(again).toEqual({ ...first, deduped: true });
    expect(first.path).toBe(`log/insertions/2026-08/${first.event.id}.json`);
    expect(first.event.author).toEqual({ kind: "user", id: "nick@example.com" });
    expect(readSourceInsertionLog(vault)).toEqual([first.event]);
  });

  test("classifies verified agents and source services without model inference", () => {
    expect(insertionAuthor({ from: "Claude Code", from_kind: "agent" })).toEqual({ kind: "agent", id: "claude-code" });
    expect(insertionAuthor({ source: "granola" })).toEqual({ kind: "service", id: "granola" });
  });

  test("normal intake writes the event natively; a request writes one too (#521)", () => {
    const vault = root();
    receive({
      root: vault, dest: "inbox", poke: false,
      content: "---\nid: native-1\ntitle: Native\nsource: granola\nreceived: 2026-08-16T11:00:00.000Z\n---\nbody\n",
    });
    const rows = readSourceInsertionLog(vault);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_id: "native-1", title: "Native", body: "body\n" });
    expect(rows[0]?.imported_path).toBeUndefined();
    // #496: the insertion event IS the landing — no references/*.md is written
    expect(existsSync(join(vault, "references"))).toBe(false);

    receive({
      root: vault, dest: "inbox", poke: false,
      content: "---\nid: request-1\nkind: request\n---\ndo something\n",
    });
    const after = readSourceInsertionLog(vault);
    expect(after).toHaveLength(2);
    const req = after.find((e) => e.source_id === "request-1");
    expect(req).toMatchObject({ body: "do something\n" });
    expect(req?.envelope["kind"]).toBe("request");
  });
});

test("sourceMoment shows when a source is from, not when it landed", () => {
  const landed = "2026-09-25T17:09:53.000Z";
  expect(sourceMoment({ occurred_at: "2026-03-02", received_at: landed, envelope: { seq: "2026-03-02T08:15:00.000Z" } })).toBe("2026-03-02T08:15:00.000Z");
  expect(sourceMoment({ occurred_at: "2026-03-02", received_at: landed })).toBe("2026-03-02T12:00:00.000Z");
  expect(sourceMoment({ occurred_at: "2026-09-25", received_at: landed })).toBe(landed);
  expect(sourceMoment({ occurred_at: "2026-03-02T08:15:00Z", received_at: landed })).toBe("2026-03-02T08:15:00Z");
  expect(sourceMoment({ received_at: landed, envelope: { seq: 4 } })).toBe(landed);
  expect(sourceMoment({})).toBe("");
});
