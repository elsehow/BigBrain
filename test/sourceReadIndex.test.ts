import { expect, test } from "bun:test";
import { sourceReadIndex } from "../web/ui/src/lib/sourceReadIndex";
import type { SourceReadState } from "../lib/sourceReadStateTypes";
const state = (unread: boolean | null): SourceReadState => ({ unread, status: unread === null ? "unavailable" : "synced", writable: unread !== null, provider: "email" });

test("recent/search thread aliases reflect live imported member flags without turning a read member unread", () => {
  const nodes = [{ id: "thread", path: "thread.md", memberPaths: ["read.json", "unread.json", "old-thread.md"], readState: state(false) }];
  const rows = [{ path: "read.json", readState: state(false) }, { path: "unread.json", readState: state(true) }];
  const index = sourceReadIndex(nodes, rows);
  for (const path of ["thread", "thread.md", "old-thread.md", "unread.json"]) expect(index.get(path)?.unread).toBe(true);
  expect(index.get("read.json")?.unread).toBe(false);
  expect(index.has("not-imported.json")).toBe(false);
  rows[1]!.readState = state(false);
  expect(sourceReadIndex(nodes, rows).get("old-thread.md")?.unread).toBe(false);
});

test("fresh unavailable state overrides an older graph snapshot and canonical thread state wins", () => {
  const nodes = [{ id: "thread", path: "thread.md", memberPaths: ["message.json", "alias.md"], readState: state(true) }];
  const index = sourceReadIndex(nodes, [{ path: "thread.md", readState: state(null) }, { path: "message.json", readState: state(false) }]);
  expect(index.get("thread.md")?.status).toBe("unavailable");
  expect(index.get("alias.md")?.unread).toBeNull();
  expect(index.get("message.json")?.unread).toBe(false);
});
