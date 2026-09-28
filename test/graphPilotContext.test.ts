import { expect, test } from "bun:test";
import { activeContextPilot } from "../web/ui/src/lib/graphPilotContext";
import { withPilotChats } from "../web/ui/src/lib/pilotChatGraph";
import { newPilotChatSession } from "../lib/pilotChatTypes";

test("roster agents stay active between turns and release their context on closure", () => {
  const session = newPilotChatSession(["context"]);
  const base = { hash: "context", nodes: [{ id: "context", title: "Context", group: "source", degree: 1 }], edges: [] };
  for (const phase of ["working", "answered", "failed", "interrupted"] as const) {
    const graph = withPilotChats(base, [{ ...session, phase, lifecycle: "dormant" }], null)!;
    expect(activeContextPilot(graph.nodes.find(n => n.id === session.id)!)).toBe(true);
    const closed = withPilotChats(base, [{ ...session, phase, deactivatedAt: "2026-09-23T12:00:00Z" }], null)!;
    expect(activeContextPilot(closed.nodes.find(n => n.id === session.id)!)).toBe(false);
  }
  expect(activeContextPilot({ pilotPhase: "idle" })).toBe(false);
  expect(activeContextPilot({ pilotPhase: "working" })).toBe(true);
  expect(activeContextPilot({ pilotPhase: "active", pilotNeedsYou: true })).toBe(true);
});
