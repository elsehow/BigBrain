/** Adapter for the existing local viewer. Shared requests never fall through to
 * personal routes. No remote records are persisted in the personal vault. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readBody } from './httpx';
import { allowVaultRequest } from './vaultBoundary';
import { connectionStorePath, readConnections, publicConnection, refreshConnectionNames, saveConnection, connectInvite, sharedRequest, SharedConnectionError, type SharedConnection, type SharedIdentity } from './sharedConnections';
import { insertionEventRel, sourceMoment, type SourceInsertion, type SourceMetadata } from './insertionLog';
import { sourceInsertionMarkdown, insertionFiler } from './sourceFeed';
import { assertionSourceReferences, type AssertionEvent } from './assertionLog';
import type { AssertionView } from './sharedVault';
import { sharedGraphLayout } from './sharedGraphLayout';
import type { GraphNode, GraphEdge } from './graph';
import { sha256hex } from './hash';

async function pages<T>(c: SharedConnection, kind: string): Promise<T[]> {
  const items: T[] = []; let cursor: string | null = null;
  do {
    const page: { items: T[]; next_cursor: string | null } = await sharedRequest(c, `/v1/${kind}?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    items.push(...page.items); cursor = page.next_cursor;
  } while (cursor);
  return items;
}
const entityPath = (id: string) => `projection/entities/${id}.md`;
type SharedSource = SourceMetadata & { body?: string; submitted_at?: string };
export function sharedProjection(sources: SharedSource[], views: AssertionView[]) {
  const assertions = views.filter(v => !v.revocation).map(v => v.assertion);
  const byId = new Map(sources.map(s => [s.id, s]));
  const entities = new Map(assertions.flatMap(a => a.entities.map(e => [e.id, e] as const)));
  const nodes: GraphNode[] = sources.map(s => ({ id: `source:${s.id}`, title: s.title, path: insertionEventRel(s), group: 'source', degree: 0, ...insertionFiler(s) }));
  nodes.push(...[...entities.values()].map(e => ({ id: e.id, title: e.label, path: entityPath(e.id), group: 'entity', entity: true as const, degree: 0 })));
  const edges: GraphEdge[] = [];
  for (const a of assertions) for (const e of a.entities) for (const ref of assertionSourceReferences(a)) {
    if (byId.has(ref.insertion_id) && !edges.some(edge => edge.source === e.id && edge.target === `source:${ref.insertion_id}`))
      edges.push({ source: e.id, target: `source:${ref.insertion_id}` });
  }
  for (const node of nodes) node.degree = edges.filter(e => e.source === node.id || e.target === node.id).length;
  const received = (s: SharedSource) => s.submitted_at ?? sourceMoment(s);
  const recent = [...sources].sort((a,b) => received(b).localeCompare(received(a))).map(s => ({ path: insertionEventRel(s), title: s.title, modified: Date.parse(received(s)) || 0, author: s.author.id, action: 'created', ...insertionFiler(s), id: s.source_id, insertionId: s.id, type: 'source' }));
  const assertionView = (a: AssertionEvent) => ({ id: a.id, text: a.text, confidence: a.confidence, created_at: a.created_at, author: a.author,
    entities: a.entities.map(e => ({ ...e, path: entityPath(e.id) })),
    sources: assertionSourceReferences(a).flatMap(ref => { const s = byId.get(ref.insertion_id); return s ? [{ ...ref, title: s.title, path: insertionEventRel(s), ...insertionFiler(s) }] : []; }) });
  const note = (path: string) => {
    const source = sources.find(s => insertionEventRel(s) === path);
    if (source) return { path, content: sourceInsertionMarkdown({ ...source, body: source.body ?? '' }), sourceAssertions: assertions.filter(a => assertionSourceReferences(a).some(r => r.insertion_id === source.id)).map(assertionView) };
    const entity = [...entities.values()].find(e => entityPath(e.id) === path);
    if (entity) { const list = assertions.filter(a => a.entities.some(e => e.id === entity.id)).map(assertionView); return { path, content: `# ${entity.label}\n\n${list.map(a => a.text).join('\n\n')}`, projectedEntity: { ...entity, assertions: list } }; }
    return null;
  };
  return { sources, assertions, recent, note, graph: { nodes, edges, projection: 'assertions' as const, hash: sha256hex(JSON.stringify([sources, assertions])) } };
}

export async function sharedWorkspace(req: IncomingMessage, res: ServerResponse, store = connectionStorePath()): Promise<boolean> {
  let url: URL;
  try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { json(res, 400, { error: 'Invalid URL.' }); return true; }
  if (!url.pathname.startsWith('/api/')) return false;
  const selected = req.headers['x-bigbrain-workspace'] ?? url.searchParams.get('workspace');
  if (selected == null && url.pathname !== '/api/shared-connections') return false;
  try {
    if (url.pathname === '/api/shared-connections') {
      if (req.method === 'GET') json(res, 200, { connections: await refreshConnectionNames(store) });
      else if (req.method === 'POST') { const input=JSON.parse(await readBody(req,16384)); json(res,201,input.invite?await connectInvite(store,input.invite):await saveConnection(store,input)); }
      else json(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    const connection = readConnections(store).find(c => c.id === selected);
    if (!connection) throw new SharedConnectionError(404, 'Shared connection not found.');
    const identity = `shared:${connection.id}`;
    if (!allowVaultRequest(req, res, identity)) return true;
    const who = await sharedRequest<SharedIdentity>(connection, '/v1/whoami');
    if (!who.permissions.includes('read')) throw new SharedConnectionError(403, 'Read access has been removed.');
    const path = url.pathname;
    if (path === '/api/shared-identity' && req.method === 'GET') { json(res, 200, { ...publicConnection(connection), identity: who }); return true; }
    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: vault\ndata: ${JSON.stringify(identity)}\n\n`);
      let head = -1, busy = false;
      const poll = async () => {
        if (busy || res.destroyed) return; busy = true;
        try { const feed = await sharedRequest<{ head: number }>(connection, '/v1/feed?limit=1'); if (feed.head !== head) { head = feed.head; res.write('data: {}\n\n'); } }
        catch { res.write('event: unavailable\ndata: {}\n\n'); res.end(); }
        finally { busy = false; }
      };
      const timer = setInterval(() => void poll(), 3000); res.on('close', () => clearInterval(timer)); void poll(); return true;
    }
    if (path === '/api/shared/assertions' && req.method === 'GET') { json(res, 200, await pages<AssertionView>(connection, 'assertions')); return true; }
    if (req.method === 'POST' && /^\/api\/shared\/assertions(?:\/ast_[a-f0-9]+\/(?:correct|retract))?$/.test(path)) {
      if (!who.permissions.includes('write')) throw new SharedConnectionError(403, 'This connection is read-only.');
      json(res, 200, await sharedRequest(connection, path.replace('/api/shared/', '/v1/'), JSON.parse(await readBody(req)))); return true;
    }
    if (req.method === 'POST') {
      if (!who.permissions.includes('write')) throw new SharedConnectionError(403, 'This connection is read-only.');
      if (path === '/api/drop') {
        const body = JSON.parse(await readBody(req));
        if (body.attachments?.length) throw new SharedConnectionError(400, 'Servers currently accept text and Markdown files. Attachments are not supported yet.');
        const receipt = await sharedRequest<{ id: string; source_id: string }>(connection, '/v1/evidence', { title: body.name, body: body.content });
        const source = await sharedRequest<SourceInsertion>(connection, `/v1/evidence/${receipt.id}`);
        json(res, 200, { id: receipt.source_id, path: insertionEventRel(source), ref_path: insertionEventRel(source), via: 'shared' }); return true;
      }
      throw new SharedConnectionError(403, 'This action is not available on servers yet.');
    }
    if (req.method !== 'GET') throw new SharedConnectionError(405, 'Method not allowed.');
    // Only explicit, inert compatibility responses. All other routes fail closed.
    const empty: Record<string, unknown> = {
      '/api/setup': null, '/api/telemetry': null, '/api/source/read-state': { sources: [] }, '/api/pilot/chat': { sessions: [] }, '/api/pilot/work': { sessions: [] },
      '/api/note-log': { entries: [] }, '/api/entity/folds': { groups: [], proposedAt: null },
    };
    if (path in empty) { json(res, 200, empty[path]); return true; }
    if (!['/api/vault','/api/recent','/api/graph','/api/note','/api/search','/api/notes'].includes(path)) throw new SharedConnectionError(403, 'This feature is unavailable on servers.');
    const [sources, assertions] = await Promise.all([pages<SharedSource>(connection, 'evidence'), pages<AssertionView>(connection, 'assertions')]);
    if (path === '/api/note') {
      const id = url.searchParams.get('path')?.match(/(ins_[a-f0-9]{24})\.json$/)?.[1];
      const index = sources.findIndex(s => s.id === id);
      if (index >= 0) sources[index] = { ...sources[index], ...await sharedRequest<SourceInsertion>(connection, `/v1/evidence/${id}`) };
    }
    const view = sharedProjection(sources, assertions);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0), limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    if (path === '/api/vault') json(res, 200, { view: { references: sources.length, entities: view.graph.nodes.filter(n => n.group === 'entity').length }, inbox: { pending: 0, unsorted: 0 }, requests: { open: 0, done: 0 } });
    else if (path === '/api/graph') json(res, 200, sharedGraphLayout(view.graph));
    else if (path === '/api/recent') json(res, 200, { recent: view.recent.slice(offset, offset+limit), total: sources.length, nextOffset: offset+limit < sources.length ? offset+limit : null });
    else if (path === '/api/note') { const note = view.note(url.searchParams.get('path') ?? ''); json(res, note ? 200 : 404, note ?? { error: 'Not found.' }); }
    else if (path === '/api/notes') json(res, 200, { dir: url.searchParams.get('dir'), notes: [] });
    else {
      const result = await sharedRequest<{ hits: Array<{ kind: string; id: string; snippet: string }> }>(connection, `/v1/search?q=${encodeURIComponent(url.searchParams.get('q') ?? '')}&limit=50`);
      const matched = new Map<string, string>();
      for (const hit of result.hits) {
        if (hit.kind === 'evidence') matched.set(`source:${hit.id}`, hit.snippet);
        else { const a = view.assertions.find(a => a.id === hit.id); for (const e of a?.entities ?? []) matched.set(e.id, hit.snippet); for (const r of a ? assertionSourceReferences(a) : []) matched.set(`source:${r.insertion_id}`, hit.snippet); }
      }
      const hits = view.graph.nodes.filter(n => matched.has(n.id)).map(n => ({ dir: n.group === 'entity' ? 'entities' : 'references', note: { name: n.title, path: n.path, modified: 0, size: 0 }, title: n.title, snippet: matched.get(n.id) ?? '', band: n.band, from: n.from }));
      json(res, 200, { hits: hits.slice(offset,offset+limit), nextOffset: offset+limit < hits.length ? offset+limit : null, total: hits.length });
    }
  } catch (error) {
    if (!res.headersSent) json(res, error instanceof SharedConnectionError ? error.status : 500, { error: error instanceof SharedConnectionError ? error.message : 'Could not load the shared vault.' });
    else res.end();
  }
  return true;
}
