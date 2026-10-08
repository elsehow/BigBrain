// Shared synthetic API for production-shell previews and built-entry checks.
import { installIntegrationAccessScene } from './integrationAccessScene';
import type { WorkSession } from '../../../../lib/workHistory';
import { pilotChatSummary, pilotChatDetail, matchesPilotQuery } from '../../../../lib/pilotChatSummary';
import { api } from '../lib/api';
import { newPilotChatSession } from '../../../../lib/pilotChatTypes';
import { installFakeApi, setVaultState, BRIEFINGS } from './fakeApi';
export async function installGraphFixture() {
  const fetchSnapshot = window.fetch.bind(window);
  installFakeApi();
  // Exercise the real capture UI without sending sample files to a vault.
  api.drop = async (name) => {
    await new Promise(resolve => setTimeout(resolve, 500));
    return { path: name, via: 'sample', id: `sample-${crypto.randomUUID()}` };
  };
  api.enqueue = async () => ({ path: 'sample-note', via: 'sample' });
  const scene = structuredClone(BRIEFINGS.many!);
  scene.hash = '/';
  const topics = ['Planning notes', 'Design review', 'Research update', 'Meeting recap', 'Project milestones', 'Field observations', 'Reading notes', 'Weekly review'];
  for (let i = 0; i < 80; i++) {
    const path = `sources/preview-record-${i + 1}.md`;
    const title = `${topics[i % topics.length]} — ${Math.floor(i / topics.length) + 1}`;
    const angle = i * 2.4;
    const radius = 100 + Math.sqrt(i + 1) * 32;
    scene.graph.nodes.push({ id: path, path, title, group: 'source', degree: 1,
      x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    scene.graph.edges.push({ source: scene.graph.nodes[i % 4]!.id, target: path });
    scene.notes![path] = { path, content: `# ${title}\n\nSample record for exploring the graph and scrolling lists.` };
  }
  // Local profiling can replay graph geometry with fabricated note responses.
  const graphSnapshot = new URLSearchParams(location.search).get('graphSnapshot');
  if (graphSnapshot) {
    const url = new URL(graphSnapshot, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/api/')) throw new Error('Use a local static graph snapshot');
    const response = await fetchSnapshot(url);
    if (!response.ok) throw new Error('Could not load graph snapshot');
    scene.graph = await response.json();
    for (const node of scene.graph.nodes) {
      const path = node.path ?? node.id;
      scene.notes![path] = { path, content: `# ${node.title}\n\nFabricated profiling note.` };
    }
  }
  scene.recent = scene.graph.nodes.filter(n => n.path).map(n => ({ path: n.path!, title: n.title, modified: Date.now(), band: 'person', author: 'Sample', action: 'added' }));
  const workspaces = scene.graph.nodes.filter(n => n.group === 'memory' && !/(^|\/)MEMORY\.md$/.test(n.path ?? n.id));
  const sharedNote = "sources/shared-design-review.md";
  if (!graphSnapshot) {
    const titles = ['Atlas planning', 'Design system', 'Field research', 'Launch notes', 'Market research', 'Product roadmap', 'Reading room', 'Research archive', 'Team notebook', 'Weekly planning', 'Writing desk', 'Zeta experiments'];
    workspaces.forEach((node, i) => {
      node.title = titles[i] ?? node.title;
      const note = scene.notes?.[node.path ?? node.id];
      if (note) note.content = note.content.replace(/^# .+$/m, '# ' + node.title);
    });
    // Give the study two distinct workspaces connected by a shared source.
    const memoryIds = new Set(workspaces.flatMap(node => [node.id, node.path]));
    scene.graph.edges = scene.graph.edges.filter(edge => !(memoryIds.has(edge.source) && memoryIds.has(edge.target)));
    scene.graph.nodes.push({ id: sharedNote, path: sharedNote, title: "Shared design review", group: "source", degree: 2 });
    for (const memory of workspaces.slice(0, 2)) scene.graph.edges.push({ source: sharedNote, target: memory.id });
    scene.notes![sharedNote] = { path: sharedNote, content: "# Shared design review\n\nDesign decisions shared by Atlas planning and Design system." };
  }
  const titleView = new URLSearchParams(location.search).get('titleView');
  if (titleView) {
    const path = BRIEFINGS.source.hash!.replace('/vault/', '');
    const title = 'How neighborhood workshops are making room for a new generation of independent makers';
    scene.graph.nodes.find(node => node.path === path)!.title = title;
    scene.notes![path] = { ...scene.notes![path]!, content: `# ${title}\n`, modified: Date.parse('2026-09-28T17:12:00Z') };
    if (titleView === 'loading') scene.briefing = 'loading';
    location.hash = `/vault/${path}`;
  }
  if (new URLSearchParams(location.search).has('annotations')) {
    const clip = { id: 'sample-clip', path: 'sources/sample-clip.md', title: 'Workshop report', modified: Date.now() - 2000, band: 'person' as const, author: 'Sample', action: 'added', type: 'source' };
    const note = { ...clip, id: 'sample-note', path: 'sources/sample-note.md', title: 'Recommended by a colleague', modified: Date.now(), about: clip.id };
    scene.recent = [note, clip, ...scene.recent!];
    for (const row of [clip, note]) scene.notes![row.path] = { path: row.path, content: `# ${row.title}\n\nSample annotation preview.` };
  }
  setVaultState(scene);
  const integrationScene = new URLSearchParams(location.search).get("integration-activation");
  installIntegrationAccessScene(integrationScene === "fail");
  // Only the sample scene intercepts chat. Live mode uses the real endpoints.
  const sample = newPilotChatSession([scene.graph.nodes[0]!.id]);
  sample.id = 'pilot-11111111111111111111111111111111';
  sample.title = 'Atlas planning'; sample.phase = 'answered'; sample.lifecycle = 'active';
  // `?working`: this Desktop is mid-turn, so Field's working motion can be seen
  if (new URLSearchParams(location.search).has('working')) sample.phase = 'working';
  sample.messages = [
    { id: 'sample-question', role: 'user', text: 'What connects these project notes?', at: sample.created },
    { id: 'sample-answer', role: 'assistant', text: 'The [[sources/shared-design-review.md|Shared design review]] connects the Atlas update and project notebook. It captures the decisions behind the planned expansion.', at: sample.created },
  ];
  const older = structuredClone(sample);
  older.id = 'pilot-22222222222222222222222222222222'; older.title = 'Earlier project review';
  older.created = new Date(Date.parse(sample.created) - 86400000).toISOString();
  older.updated = older.created; older.lastActivityAt = new Date(Date.now() - 11 * 60 * 60 * 1000).toISOString(); older.lifecycle = 'dormant';
  const sessions = [older, sample];
  if (workspaces[0] && workspaces[1]) {
    sample.category = { memory: workspaces[0].id, inputKey: 'fixture', model: 'fixture', assignedAt: sample.created, reason: 'Project planning.' };
    older.category = { ...sample.category };
    sample.context = [workspaces[0].id]; sample.seed = [...sample.context];
    older.lastActivityAt = older.created;
    older.context = [...sample.context]; older.seed = [...sample.context];
    const review = structuredClone(sample);
    review.category = { ...sample.category, memory: workspaces[1].id };
    review.id = 'pilot-33333333333333333333333333333333'; review.title = 'Atlas design review';
    review.context = [sharedNote]; review.seed = [...review.context]; review.phase = 'answered'; review.lifecycle = 'ingested';
    review.lastActivityAt = new Date(Date.now() - 11 * 60 * 60 * 1000).toISOString();
    const design = structuredClone(sample);
    design.id = 'pilot-44444444444444444444444444444444'; design.title = 'Component audit';
    design.category = { ...sample.category, memory: workspaces[1].id };
    design.context = [workspaces[1].id]; design.seed = [...design.context];
    const stopped = structuredClone(sample);
    stopped.id = 'pilot-55555555555555555555555555555555'; stopped.title = 'Completed Atlas review'; stopped.deactivatedAt = new Date().toISOString();
    sessions.push(review, design, stopped);
  }
  const archivedWorker: WorkSession | undefined = new URLSearchParams(location.search).has('archived-worker') ? {
    id: 'work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'Atlas implementation', provider: 'pi', cwd: '/sample/project',
    created: sample.created, updated: sample.updated, status: 'interrupted',
    origin: { pilot: sample.id, message: 'sample-question' }, context: { nodes: [...sample.context] }, receipts: [],
    worker: { archivedAt: sample.updated, operations: [{ id: 'operation', tool: 'write', status: 'uncertain', at: sample.updated }] },
    messages: [{ id: 'historical-task', role: 'user', text: 'Implement the Atlas plan using the supplied project notes.', at: sample.created },
      { id: 'historical-answer', role: 'agent', text: 'The project notes are saved for review.', at: sample.created }],
  } : undefined;
  window.addEventListener('workbench-agent-category', event => {
    const { id, memory } = (event as CustomEvent<{ id: string; memory: string | null }>).detail;
    const session = sessions.find(s => s.id === id);
    if (session) {
      session.category = { memory, inputKey: 'fixture-change', model: 'fixture', assignedAt: new Date().toISOString(), reason: 'Updated task.' };
      session.revision++;
    }
  });
  const fakeFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const path = url.pathname;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (archivedWorker && path === '/api/pilot/work') return json(url.searchParams.has('id') ? archivedWorker : { sessions: [archivedWorker], issues: [] });
    if (path === '/api/search') {
      const query = url.searchParams.get('q') ?? '';
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 50);
      const found = scene.graph.nodes.filter(n => n.path && n.title.toLowerCase().includes(query.toLowerCase()));
      return json({ query, hits: found.slice(offset, offset + limit).map(n => ({ dir: n.group, title: n.title, snippet: '',
        note: { path: n.path, name: n.title, modified: 0, size: 0 } })), nextOffset: offset + limit < found.length ? offset + limit : null });
    }
    if (path === '/api/pilot/chat') return json({ sessions: sessions.filter(s => !url.searchParams.has("ids") || url.searchParams.get("ids")!.split(",").includes(s.id)).filter(s => matchesPilotQuery(s, url.searchParams.get('query') ?? '')).map(pilotChatSummary) });
    if (path === '/api/pilot/chat/session') { const s = sessions.find(s => s.id === url.searchParams.get('id')); return s ? json(pilotChatDetail(s)) : json({ error: 'Missing conversation' }, 404); }
    if (!path.startsWith('/api/pilot/chat/') || path.endsWith('/models') || path.endsWith('/backend') && !options?.body) return fakeFetch(input, options);
    const body = JSON.parse(typeof options?.body === 'string' ? options.body : '{}');
    if (path.endsWith('/create')) { const s = newPilotChatSession(body.context ?? []); s.id = body.id;
      const memory = workspaces.find(n => s.context.length === 1 && n.id === s.context[0]);
      if (memory) s.category = { memory: memory.id, inputKey: '', model: '', assignedAt: s.created, reason: 'Selected memory.' };
      // Match PilotChats.create/save: persisted creation is newer than the local draft.
      s.revision++; sessions.push(s); return json(pilotChatDetail(s)); }
    if (path.endsWith('/presence')) return json({ ok: true });
    const s = sessions.find(s => s.id === body.id);
    if (!s) return json({ error: 'Sample conversation not found.' }, 404);
    if (path.endsWith('/backend')) { s.backend = body.backend; s.model = body.backend.model; }
    else if (path.endsWith('/stop-tree')) {
      s.phase = 'interrupted'; s.lifecycle = 'dormant'; s.deactivatedAt = new Date().toISOString();
    }
    else if (path.endsWith('/draft')) s.draft = body.text;
    else if (path.endsWith('/context')) { s.context = body.nodes; s.title = body.title; s.viewRevision++; }
    else if (path.endsWith('/rename')) { s.title = body.title; s.titleSource = 'human'; s.viewRevision++; }
    else if (path.endsWith('/context-add')) s.context = [...new Set([...s.context, ...body.nodes])];
    else if (path.endsWith('/send')) {
      s.messages.push({ id: crypto.randomUUID(), role: 'user', text: body.text, at: new Date().toISOString() },
        { id: crypto.randomUUID(), role: 'assistant', text: 'This is the sample vault. Your message stayed in this browser; no agent was contacted.', at: new Date().toISOString() });
      s.draft = ''; s.phase = 'answered';
    } else return json({ error: 'This action is unavailable in the sample vault.' }, 409);
    s.revision++; s.updated = new Date().toISOString(); return json(pilotChatDetail(s));
  }) as typeof window.fetch;
}
