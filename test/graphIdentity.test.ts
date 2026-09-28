import { expect, test } from "bun:test";
import { findNode, graphIdentityIndex } from "../lib/graphIdentity";

test("batch index preserves first-match semantics across IDs and all aliases", () => {
  const nodes = [
    { id: "thread", path: "thread.md", memberPaths: ["message", "later"], sourcePaths: ["source"] },
    { id: "later", path: "source", sourcePaths: ["other"] },
    { id: "empty-path", path: "" },
    { id: "no-path", path: null },
  ];
  const index = graphIdentityIndex(nodes);
  for (const key of ["thread", "thread.md", "message", "later", "source", "other", "", "no-path", "missing"]) {
    expect(index.get(key) ?? -1).toBe(findNode(nodes, key));
  }
});

test("new batches see in-place graph edits and alias changes", () => {
  const nodes = [{ id: "one", memberPaths: ["before"] }];
  graphIdentityIndex(nodes);
  nodes[0]!.memberPaths = ["after"];
  nodes.push({ id: "two", memberPaths: [] });
  const next = graphIdentityIndex(nodes);
  expect(next.has("before")).toBe(false);
  expect(next.get("after")).toBe(0);
  expect(next.get("two")).toBe(1);
});
