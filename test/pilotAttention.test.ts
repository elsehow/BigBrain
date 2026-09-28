import { test, expect } from 'bun:test';
import { newPilotChatSession } from '../lib/pilotChatTypes';
import { pilotRoster, isStoppedEmptyPilot } from '../web/ui/src/lib/pilotAttention';
import { pilotVisualPhase } from '../web/ui/src/lib/pilotAppearance';
import { withPilotSearch } from '../web/ui/src/lib/pilotSearch';
import { withPilotChats } from '../web/ui/src/lib/pilotChatGraph';
const session = () => ({ ...newPilotChatSession([], 'pilot-' + 'a'.repeat(32)), phase: 'answered' as const, lifecycle: 'dormant' as const });
test('full Agents roster retains archived Pilots without active requests', () => {
  const s = {...session(), deactivatedAt:new Date().toISOString()};
  expect(pilotRoster([s])).toEqual([]);
  expect(pilotRoster([s],true)).toMatchObject([{id:s.id, archived:true, phase:'idle', state:'idle', requests:[], unread:false}]);
});
test('roster stays oldest first across activity changes and reordered refreshes', () => {
  const older = { ...session(), id: 'older', lifecycle: 'active' as const, created: '2026-09-20T10:00:00.000Z' };
  const newer = { ...session(), id: 'newer', lifecycle: 'active' as const, created: '2026-09-21T10:00:00.000Z' };
  const input = [newer, older];
  expect(pilotRoster(input).map(p => p.id)).toEqual(['older', 'newer']);
  expect(input.map(p => p.id)).toEqual(['newer', 'older']);
  older.updated = '2026-09-22T10:00:00.000Z';
  expect(pilotRoster([older, { ...newer, phase: 'working' }]).map(p => p.id)).toEqual(['older', 'newer']);
  expect(pilotRoster([newer, { ...older, phase: 'working' }]).map(p => p.id)).toEqual(['older', 'newer']);
});
test('Pilot requests persist until every request is resolved', () => {
  const s = session();
  s.notifications = ['a', 'b'].map(id => ({ id, key:id, pilotId:s.id, pilotTitle:s.title, messageId:'m', kind:'question' as const, text:'Which project?', at:'', seen:false }));
  expect(pilotRoster([s])).toMatchObject([{ id: s.id, state: 'waiting', requests: [{ id: 'a' }, { id: 'b' }] }]);
  const graph = withPilotChats({ nodes: [], edges: [], hash: 'test' }, [s], null);
  expect(graph?.nodes[0]).toMatchObject({ id: s.id, group: 'pilot', pilotNeedsYou: true, pilotPhase: 'active' });
  s.notifications![0]!.resolved = true;
  expect(pilotRoster([s])[0]?.state).toBe('waiting');
  s.notifications![1]!.resolved = true;
  expect(pilotRoster([s])[0]?.state).toBe("idle");
});
test('seen and dismissed questions remain pending; accepted replies and explicit resolution clear them', () => {
  const s = session();
  s.notifications = [{ id: 'q', key: 'q', pilotId: s.id, pilotTitle: 'Test', messageId: 'm', kind: 'question', text: 'Which dataset?', at: '', seen: true, dismissed: true }];
  expect(pilotRoster([s])[0]?.state).toBe('waiting');
  s.pendingInputs = [{ id: 'answer', text: 'Original', mode: 'text', notificationId: 'q' }];
  expect(pilotRoster([s])[0]?.state).toBe("idle");
  s.pendingInputs = []; s.notifications[0]!.resolved = true;
  expect(pilotRoster([s])[0]?.state).toBe("idle");
  s.notifications[0]!.resolved = false; s.notifications[0]!.kind = 'update';
  expect(pilotRoster([s])[0]?.state).toBe("idle");
});
test('explicit closure overrides old unanswered requests', () => {
  const s = session();
  s.deactivatedAt = new Date().toISOString();
  s.notifications = [{ id: 'old', key: 'old', pilotId: s.id, pilotTitle: s.title, messageId: 'm', text: 'Question', kind: 'question', at: '', seen: false }];
  expect(pilotRoster([s])).toEqual([]);
  const g = withPilotChats({ nodes: [], edges: [], hash: 'closed' }, [s], null);
  expect(g!.nodes[0]).toMatchObject({ pilotPhase: 'idle', pilotNeedsYou: false });
  expect(g!.nodes[0]!.live).toBeUndefined();
  expect(withPilotChats({ nodes: [], edges: [], hash: 'closed' }, [s], s.id)!.nodes[0]!.pilotPhase).toBe('idle');
  expect(s.notifications[0]!.resolved).toBeUndefined();
});
test('prepared drafts remain discoverable while empty drafts stay hidden', () => {
  const s = newPilotChatSession([]);
  expect(pilotRoster([s])).toEqual([]);
  s.draft = 'Investigate hiring';
  expect(pilotRoster([s])[0]?.id).toBe(s.id);
});

test('stopped empty drafts are hidden but saved content and active drafts remain', () => {
  const draft = newPilotChatSession([]);
  expect(isStoppedEmptyPilot(draft)).toBe(false);
  const stopped = { ...draft, deactivatedAt: '2026-09-21T12:00:00Z' };
  expect(isStoppedEmptyPilot(stopped)).toBe(true);
  expect(isStoppedEmptyPilot(stopped, 'unsaved text')).toBe(false);
  expect(isStoppedEmptyPilot({ ...stopped, draft: 'keep this' })).toBe(false);
  expect(isStoppedEmptyPilot({ ...stopped, live: 'partial response' })).toBe(false);
  expect(isStoppedEmptyPilot({ ...stopped, messages: [{ id: 'm', role: 'user', text: 'Hello', at: stopped.created }] })).toBe(false);
});


test('activity survives any age or engine lifecycle until explicitly stopped', () => {
  for (const lifecycle of ['active', 'dormant', 'ingested'] as const) {
    for (const lastActivityAt of ['2000-01-01', 'invalid', undefined]) {
      const s = { ...session(), lifecycle, lastActivityAt };
      expect(pilotRoster([s])).toHaveLength(1);
      expect(pilotRoster([{ ...s, deactivatedAt: new Date().toISOString() }])).toEqual([]);
    }
  }
});

test('draft roster uses draft text and the draft visual phase', () => {
  const s = { ...session(), phase: 'draft' as const, title: 'New session', draft: 'test' };
  expect(pilotRoster([s])[0]).toMatchObject({ title: 'test…', phase: 'draft' });
  s.draft = 'word '.repeat(100);
  expect(pilotRoster([s])[0]!.title.length).toBeLessThanOrEqual(65);
  expect(pilotRoster([{ ...s, phase: 'answered' }])[0]!.title).toBe('New session');
});


test('roster, graph and search share activity styling across engine lifecycle and stop states', () => {
  for (const lifecycle of ['active', 'dormant', 'ingested'] as const) {
    for (const phase of ['draft', 'answered', 'working', 'interrupted', 'failed'] as const) {
      for (const expired of [false, true]) for (const stopped of [false, true]) {
        const s = { ...session(), phase, lifecycle, draft: 'Prepared prompt',
          lastActivityAt: new Date(Date.now() - (expired ? 365 * 86400000 : 60_000)).toISOString(),
          deactivatedAt: stopped ? new Date().toISOString() : undefined };
        const active = !stopped;
        const expected = active ? phase : 'idle';
        const roster = pilotRoster([s]);
        expect(roster.length).toBe(active ? 1 : 0);
        if (active) expect(roster[0]!.phase).toBe(expected);
        expect(pilotVisualPhase(s)).toBe(expected);
        expect(withPilotChats({nodes:[],edges:[]}, [s], null)!.nodes[0]!.pilotPhase).toBe(expected);
        expect(withPilotSearch([], [s], 'prepared')[0]!.pilotPhase).toBe(expected);
      }
    }
  }
});
