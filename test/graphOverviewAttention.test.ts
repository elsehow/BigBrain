import { expect, test } from 'bun:test';
import { applyOverviewAttention } from '../web/ui/src/lib/graphOverviewAttention';
import { withPilotChats } from '../web/ui/src/lib/pilotChatGraph';
import { pilotFromWork } from '../lib/pilotWorkMigration';
import { DEFAULT_PILOT_BACKEND } from '../lib/pilotBackendTypes';
import type { WorkSession } from '../lib/workHistory';
import { newPilotChatSession } from '../lib/pilotChatTypes';
import type { GraphData } from '../web/ui/src/lib/types';

test('stopped Pilots need memory evidence, not saved context or entity links', () => {
  const s = { ...newPilotChatSession(['memory/topic'], 'pilot-test'), lifecycle: 'dormant' as const, phase: 'answered' as const, deactivatedAt: new Date().toISOString() };
  const base: GraphData = { nodes: [
    { id: 'memory/topic', title: 'Topic', group: 'memory', degree: 1 },
    { id: 'chapter', title: 'Conversation', group: 'source', degree: 1, from: 'pilot', sessionId: s.id },
  ], edges: [{ source: 'chapter', target: 'memory/topic' }] };
  const overview = (g: GraphData) => {
    const visible = new Set(g.nodes.map((_, i) => i));
    applyOverviewAttention(g.nodes, visible, new Set(), true);
    return [...visible].map(i => g.nodes[i]!.id);
  };
  const uncited = withPilotChats(base, [s], null)!;
  expect(overview(uncited)).not.toContain(s.id);
  // The conversation remains available when explicitly selected.
  expect(withPilotChats(base, [s], s.id)!.nodes.some(n => n.id === s.id)).toBe(true);
  base.nodes[1]!.memorySupport = 0.5;
  const cited = withPilotChats(base, [s], null)!;
  expect(cited.nodes.find(n => n.id === s.id)!.memorySupport).toBe(0.5);
  expect(overview(cited)).toContain(s.id);
});

test('running and waiting sessions stay visible; idle and answered sessions do not bypass memory evidence', () => {
  const nodes: (GraphData['nodes'][number] & { unread?: boolean })[] = (['idle', 'answered', 'working', 'active'] as const).map((phase, i) => ({
    id: String(i), title: phase, group: 'pilot', degree: 0, pilotPhase: phase,
  }));
  nodes.push({ id: 'unread', title: 'Unread', group: 'source', degree: 0, unread: true });
  const visible = new Set([0, 1]);
  applyOverviewAttention(nodes, visible, new Set([3]), true);
  expect([...visible]).toEqual([2, 4]);
});

test('migrated Pilot coalescing preserves memory evidence for migrated Pilot conversations', () => {
  const worker = { id: 'worker', title: 'Worker', provider: 'codex', thread: 'thread', status: 'idle', context: {}, messages: [] } as unknown as WorkSession;
  const graph: GraphData = { nodes: [{ id: 'chapter', title: 'Chapter', group: 'source', degree: 1,
    from: 'codex', sessionId: 'thread', memorySupport: 0.75 }], edges: [] };
  const pilot = pilotFromWork(worker, DEFAULT_PILOT_BACKEND);
  const result = withPilotChats(graph, [pilot], null)!;
  expect(result.nodes.find(n => n.id === pilot.id)!.memorySupport).toBe(0.75);
});

test('all roster-active Pilots stay visible with their real context endpoints', () => {
  const running = { ...newPilotChatSession(['sources/context.md']), phase: 'working' as const };
  const answered = { ...newPilotChatSession(['sources/context.md']), phase: 'answered' as const };
  const failed = { ...newPilotChatSession([]), phase: 'failed' as const };
  const closed = { ...answered, id: 'pilot-closed', deactivatedAt: new Date().toISOString() };
  const base: GraphData = { nodes: [
    { id: 'hub', title: 'Hub', group: 'entity', degree: 1 },
    { id: 'context', path: 'sources/context.md', title: 'Context', group: 'source', degree: 1 },
    { id: 'unrelated', title: 'Unrelated', group: 'source', degree: 0 },
  ], edges: [{ source: 'hub', target: 'context' }] };
  const graph = withPilotChats(base, [running, answered, failed, closed], null)!;
  const index = (id: string) => graph.nodes.findIndex(n => n.id === id);
  const edges = graph.edges.map(e => ({ a: index(e.source), b: index(e.target), pilotContext: e.pilotContext }));
  const visible = new Set([index('hub')]);
  applyOverviewAttention(graph.nodes, visible, new Set(), false, edges);
  expect([...visible].map(i => graph.nodes[i]!.id).sort()).toEqual(['hub', 'context', running.id, answered.id, failed.id].sort());
  const excluded = new Set([index('context')]);
  // Exclusions are normally removed by resolveGraphView before this overlay.
  const filtered = new Set([index('hub')]);
  applyOverviewAttention(graph.nodes, filtered, excluded, false, edges);
  expect(filtered.has(index('context'))).toBe(false);
});
