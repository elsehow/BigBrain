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
  setVaultState(scene);
  const integrationScene = new URLSearchParams(location.search).get("integration-activation");
  installIntegrationAccessScene(integrationScene === "fail");
  // Only the sample scene intercepts chat. Live mode uses the real endpoints.
  const sample = newPilotChatSession([scene.graph.nodes[0]!.id]);
  sample.id = 'pilot-11111111111111111111111111111111';
  sample.title = 'Atlas planning'; sample.phase = 'answered'; sample.lifecycle = 'active';
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
  window.addEventListener('workbench-agent-notification', () => {
    const at = new Date().toISOString();
    const texts = [
      'The September update and project notebook disagree on the opening date. Which date should I use for the Atlas plan?',
      'I found the earlier design review and linked it to the project notebook.',
      'The weekly summary is ready. There are two decisions for you to review.',
    ];
    const text = texts[(sample.notifications?.length ?? 0) % texts.length]!;
    const id = crypto.randomUUID();
    sample.messages.push({ id, role: 'assistant', text, at });
    sample.notifications = [...sample.notifications ?? [], { id, pilotId: sample.id, pilotTitle: sample.title, messageId: id,
      key: 'atlas-opening-date', text, kind: 'question', at, seen: false }];
    sample.revision++; sample.updated = at;
  });
  const connected: WorkSession | undefined = new URLSearchParams(location.search).has('connected-agent') ? {
    id: 'work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'Atlas implementation', provider: 'pi', cwd: '/sample/project',
    created: sample.created, updated: sample.updated, status: 'needs-input',
    origin: { pilot: sample.id, message: 'sample-question' }, context: { nodes: [...sample.context] }, receipts: [],
    worker: { grant: {path:'/sample/project',mode:'read',references:[],domains:[],accounts:[]}, operations: [], request: {id:'access-fixture',kind:'access',text:'Allow edits for the implementation?',grant:{path:'/sample/project',mode:'work',references:[],domains:[],accounts:[]}} },
    messages: [{ id: 'connected-task', role: 'user', text: 'Implement the Atlas plan using the supplied project notes.', at: sample.created },
      { id: 'connected-answer', role: 'agent', text: 'The plan is ready. Please approve project editing in this task card.', at: sample.created }],
  } : undefined;
  const environmentSetup = new URLSearchParams(location.search).get('connected-agent') === 'setup';
  if (connected && environmentSetup) {
    connected.choice = {adapter:'pi',provider:'anthropic',model:'claude-sonnet-5'}; connected.model=connected.choice.model;
    delete connected.worker!.grant;
    if (connected.worker!.request?.kind==='access') { connected.worker!.request.initial=true;connected.worker!.request.text='Set up this project environment before launching.'; }
  }
  const environmentChat = new URLSearchParams(location.search).has('environment-chat');
  function environmentNotice(text: string) {
    if (!connected?.worker?.request) return;
    const key = `${connected.id}:${connected.worker.request.id}`, id = crypto.randomUUID(), at = new Date().toISOString();
    sample.messages.push({id,role:'assistant',text,at});
    sample.notifications = [...sample.notifications ?? [],{id,pilotId:sample.id,pilotTitle:sample.title,messageId:id,key,workerRequest:key,text,kind:'update',at,seen:false}];
    sample.revision++;
  }
  if(environmentChat && connected?.worker?.request?.kind==='access') {
    connected.worker.request.label='Atlas'; connected.worker.request.grant.domains=['api.example.com'];
    if(new URLSearchParams(location.search).has('needs-token'))connected.worker.request.grant.credentials=['EXAMPLE_TOKEN'];
    sample.messages=[{id:'environment-task',role:'user',text:'Set up Atlas so an agent can check the project and its issue service.',at:sample.created}];
    environmentNotice('I can use a separate checkout of Atlas and connect to its issue service. You can change the access here in chat before launching.');
  }
  const credentialNames = new Set<string>();
  if (connected && new URLSearchParams(location.search).has('pilot-status')) {
    connected.status = 'working'; delete connected.worker!.request;
    sample.phase = 'failed'; sample.error = 'Pilot completed without an answer.';
    for (let i = 0; i < 18; i++) sample.messages.push({ id: `status-history-${i}`, role: 'assistant', text: 'Earlier discussion of the implementation and its verification.', at: sample.created });
    window.addEventListener('workbench-agent-status', event => {
      connected.revision = (connected.revision ?? 0) + 1;
      connected.status = (event as CustomEvent<WorkSession['status']>).detail;
      connected.updated = new Date().toISOString();
    });
  }
  let projects = JSON.parse(localStorage.getItem('fixture-projects') ?? '[{"id":"project-fixture","label":"Atlas","path":"/sample/project","mode":"read","references":[],"domains":[],"accounts":[],"updated":"2026-09-26T00:00:00Z"}]');
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
    if (environmentSetup && path === '/api/pilot/chat/models') return json({agents:[{id:'pi/anthropic',label:'Claude',ready:true,models:[{id:'claude-sonnet-5',label:'Sonnet'},{id:'claude-opus-5-5',label:'Opus 5.5'}]}]});
    if (path === '/api/agent-orchestration') return json({projects,accounts:[{integration:'email',account:'demo@example.com'}]});
    if (path.startsWith('/api/agent-orchestration/')) {
      const body = JSON.parse(String(options?.body));
      if (path.endsWith('/inspect')) return json({path:body.path,workspace:'checkout',tools:[{name:'git',available:true},{name:'bun',available:true},{name:'gh',available:true}],credentials:[...credentialNames]});
      if (path.endsWith('/credentials')) { for (const [name,value] of Object.entries(body.values)) { if(value===null)credentialNames.delete(name);else credentialNames.add(name); } return json({names:[...credentialNames]}); }
      if (path.endsWith('/save')) { const record={...body,id:body.id??'project-'+crypto.randomUUID().replaceAll('-',''),updated:new Date().toISOString()}; projects=projects.filter((p:any)=>p.id!==record.id);projects.push(record);localStorage.setItem('fixture-projects',JSON.stringify(projects));return json(record); }
      if (path.endsWith('/remove')) {projects=projects.filter((p:any)=>p.id!==body.id);localStorage.setItem('fixture-projects',JSON.stringify(projects));return json({ok:true});}
    }
    if (connected && path === '/api/pilot/work') return json(url.searchParams.has('id') ? connected : { sessions: [connected], issues: [] });
    if (connected && path.startsWith('/api/pilot/work/')) {
      connected.revision = (connected.revision ?? 0) + 1; connected.updated = new Date().toISOString();
      window.dispatchEvent(new CustomEvent('workbench-connected-action', { detail: path }));
      const body = JSON.parse(String(options?.body));
      if (path.endsWith('/approve')) { if (connected.worker!.request?.kind !== 'access' || body.request !== connected.worker!.request.id) return json({error:'That request is stale'},400); if(body.allow) {connected.worker!.grant=body.environment??connected.worker!.request.grant;if(body.environment || body.remember){const p={...(body.environment??connected.worker!.request.grant),label:body.environment?.label??connected.worker!.request.label??connected.title,path:connected.worker!.request.grant.path,id:'project-environment-fixture',updated:new Date().toISOString()};projects=projects.filter((v:any)=>v.path!==p.path);projects.push(p);localStorage.setItem('fixture-projects',JSON.stringify(projects));connected.worker!.projectId=p.id;connected.choice=p.model??connected.choice;connected.model=connected.choice?.model;}} for(const n of sample.notifications??[])if(n.workerRequest===`${connected.id}:${body.request}`)n.resolved=true;sample.revision++;delete connected.worker!.request; connected.status=body.allow?'working':'interrupted';return json(connected); }
      if (path.endsWith('/send')) {connected.messages.push({id:crypto.randomUUID(),role:'user',text:body.text,at:new Date().toISOString()});connected.status='working';return json(connected); }
      if (path.endsWith('/stop')) { connected.status = 'interrupted'; delete connected.worker!.request; return json(connected); }
      return json({ error: 'Unavailable in sample scene' }, 400);
    }
    if (path === '/api/search') {
      const query = url.searchParams.get('q') ?? '';
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 50);
      const found = scene.graph.nodes.filter(n => n.path && n.title.toLowerCase().includes(query.toLowerCase()));
      return json({ query, hits: found.slice(offset, offset + limit).map(n => ({ dir: n.group, title: n.title, snippet: '',
        note: { path: n.path, name: n.title, modified: 0, size: 0 } })), nextOffset: offset + limit < found.length ? offset + limit : null });
    }
    if (path === '/api/pilot/chat') return json({ sessions: sessions.filter(s => !url.searchParams.has("ids") || url.searchParams.get("ids")!.split(",").includes(s.id)).filter(s => matchesPilotQuery(s, url.searchParams.get('query') ?? '')).map(pilotChatSummary) });
    if (path === '/api/pilot/chat/session') { const s = sessions.find(s => s.id === url.searchParams.get('id')); return s ? json(pilotChatDetail(s)) : json({ error: 'Missing conversation' }, 404); }
    if (path === '/api/pilot/chat/notifications') return json({ notifications: sessions.flatMap(s => s.notifications ?? []) });
    if (path === '/api/pilot/chat/notification-state') {
      const body = JSON.parse(typeof options?.body === 'string' ? options.body : '{}');
      const notice = sessions.flatMap(s => s.notifications ?? []).find(n => n.id === body.id);
      if (!notice) return json({error:'Unknown notification'},404);
      if (body.action === 'dismiss') notice.dismissed = true;
      else if (body.action === 'unseen') { notice.seen = false; notice.dismissed = false; }
      else notice.seen = true;
      return json({ok:true});
    }
    if (!path.startsWith('/api/pilot/chat/') || ['models', 'notifications'].includes(path.split('/').at(-1)!) || path.endsWith('/backend') && !options?.body) return fakeFetch(input, options);
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
      if (connected?.origin?.pilot === s.id) {
        connected.revision = (connected.revision ?? 0) + 1;
        connected.status = 'interrupted'; connected.worker!.archivedAt = s.deactivatedAt;
        delete connected.worker!.request;
      }
    }
    else if (path.endsWith('/draft')) s.draft = body.text;
    else if (path.endsWith('/context')) { s.context = body.nodes; s.title = body.title; s.viewRevision++; }
    else if (path.endsWith('/context-add')) s.context = [...new Set([...s.context, ...body.nodes])];
    else if (path.endsWith('/send')) {
      s.messages.push({ id: crypto.randomUUID(), role: 'user', text: body.text, at: new Date().toISOString() },
        { id: crypto.randomUUID(), role: 'assistant', text: 'This is the sample vault. Your message stayed in this browser; no agent was contacted.', at: new Date().toISOString() });
      for (const n of s.notifications ?? []) { if(!n.workerRequest)n.resolved = true; n.seen = true; }
      // Simulated model revision for the conversational setup scene; no real agent runs.
      if(environmentChat && connected?.worker?.request?.kind==='access' && /network off|no network|without network/i.test(body.text)) {
        for(const n of s.notifications??[])if(n.workerRequest===`${connected.id}:${connected.worker.request.id}`)n.resolved=true;
        connected.worker.request={...connected.worker.request,id:crypto.randomUUID(),grant:{...connected.worker.request.grant,domains:[],network:undefined}};
        connected.revision=(connected.revision??0)+1;
        s.messages.pop();environmentNotice('Network access is now off. Allow this revised setup when you are ready.');
      }
      s.draft = ''; s.phase = 'answered';
    } else return json({ error: 'This action is unavailable in the sample vault.' }, 409);
    s.revision++; s.updated = new Date().toISOString(); return json(pilotChatDetail(s));
  }) as typeof window.fetch;
}
