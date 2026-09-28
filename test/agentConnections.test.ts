import { expect, test } from "bun:test";
import { connectionAgent, type Connection } from "../web/ui/src/lib/connect";
import { connectTokenName } from "../lib/connect";

const connection = (name: string, via: Connection["via"] = "connect"): Connection => ({
  id: "fixture", name, via, kind: "agent", scopes: ["vault:read"],
  created: "2026-09-07T00:00:00Z", last_used: null, revoked: null,
});

test("Codex credentials never supply the Claude connection or its revoke row", () => {
  const live = [connection(connectTokenName("mac.local", "codex"))];
  expect(live.filter(c => connectionAgent(c) === "claude")).toHaveLength(0);
  expect(live.filter(c => connectionAgent(c) === "codex")).toHaveLength(1);
  live.push(connection(connectTokenName("mac.local", "claude")));
  expect(live.filter(c => connectionAgent(c) === "claude")).toHaveLength(1);
  expect(live.filter(c => connectionAgent(c) === "codex")).toHaveLength(1);
});

test("only explicit agent connection provenance and exact name prefixes count", () => {
  expect(connectionAgent(connection("codex", "pair"))).toBeNull();
  expect(connectionAgent(connection("codex-helper"))).toBeNull();
  expect(connectionAgent(connection(connectTokenName("", "claude")))).toBe("claude");
  expect(connectionAgent(connection(connectTokenName("", "codex")))).toBe("codex");
});
