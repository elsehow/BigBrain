/** Adapter for the existing local viewer. Shared requests never fall through to
 * personal routes. No remote records are persisted in the personal vault. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readBody } from './httpx';
import { allowVaultRequest } from './vaultBoundary';
import { connectionStorePath, readConnections, publicConnection, refreshConnectionNames, saveConnection, connectInvite, sharedRequest, SharedConnectionError, type SharedIdentity } from './sharedConnections';
import { insertionEventRel, sourceMoment, type SourceInsertion, type SourceMetadata } from './insertionLog';
import { sourceInsertionMarkdown, insertionFiler } from './sourceFeed';
import { assertionSourceReferences, type AssertionEvent, type IdentityAssertion } from './assertionLog';
import { DEFAULT_CUTOFF } from './sourceCopies';
import type { AssertionView } from './sharedVault';
import { followJoined, followServer, onServerChange, readServer, serverBody } from './serverStore';
import { serverMatches, viewOf } from './sharedReadUnion';
import { edgeKey, fieldLayout } from './views/layout';
import type { Graph, GraphNode, GraphEdge } from './graph';
import type { ConnectionEvidence } from './markdownGraph';
import { sha256hex } from './hash';
import { isUserNode, isUserNote } from './userNote';

const entityPath = (id: string) => `projection/entities/${id}.md`;
type SharedSource = SourceMetadata & { body?: string; submitted_at?: string };
/** Which of a server's landings are one work, and which entity each landing
 * is, as its identity assertions say (step 7): the latest word on a pair
 * stands; a model's score counts from the default cut-off. Each copy draws
 * as the earliest of them. */
function serverIdentity(sources: readonly SharedSource[], identities: readonly IdentityAssertion[]) {
  const latest = new Map<string, IdentityAssertion>();
  for (const e of [...identities].sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1)) {
    if (e.identity.says !== 'copy' && e.identity.says !== 'not-copy') continue;
    const [a, b] = e.sources.map(r => r.insertion_id).sort(); latest.set(`${a}|${b}`, e);
  }
  const at = new Map<string, string>(sources.map(s => [s.id, (s.received_at ?? s.occurred_at ?? '') + '\u0000' + s.id]));
  const parent = new Map<string, string>(), find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  for (const [key, e] of latest) {
    const same = e.identity.says === 'copy' && (e.identity.score === undefined || e.identity.score >= DEFAULT_CUTOFF);
    const [a, b] = key.split('|') as [string, string];
    if (!same || !at.has(a) || !at.has(b)) continue;
    const [x, y] = [find(a), find(b)];
    if (x !== y) { const first = (at.get(x)! < at.get(y)!) ? x : y; parent.set(x, first); parent.set(y, first); }
  }
  const bindings = identities.flatMap(e => e.identity.says === 'is-source' && e.sources[0] ? [{ entity: e.identity.entity.id, source: e.sources[0].insertion_id }] : []);
  return { copyOf: (id: string) => find(id), bindings };
}

export function sharedProjection(sources: SharedSource[], views: AssertionView[], identities: readonly IdentityAssertion[] = []) {
  const assertions = views.filter(v => !v.revocation).map(v => v.assertion);
  const { copyOf, bindings } = serverIdentity(sources, identities);
  const byId = new Map(sources.map(s => [s.id, s]));
  const entities = new Map(assertions.flatMap(a => a.entities.map(e => [e.id, e] as const)));
  // a copy draws as the work's first landing, carrying the others' paths
  const nodes: GraphNode[] = sources.filter(s => copyOf(s.id) === s.id).map(s => {
    const copies = sources.filter(o => o.id !== s.id && copyOf(o.id) === s.id).map(o => insertionEventRel(o));
    return { id: `source:${s.id}`, title: s.title, path: insertionEventRel(s), group: 'source', degree: 0, ...insertionFiler(s), ...(copies.length ? { memberPaths: copies } : {}) };
  });
  nodes.push(...[...entities.values()].map(e => ({ id: e.id, title: e.label, path: entityPath(e.id), group: 'entity', entity: true as const, degree: 0 })));
  const received = (s: SharedSource) => s.submitted_at ?? sourceMoment(s);
  // Edges as a vault's own graph draws them (lib/assertionGraph.ts): each
  // entity to each source its claim cites, entities named together to each
  // other, a repeat a heavier thread. `arrivals`: when each node and edge
  // first appeared on the server, by its clock (lib/views/layout.ts fieldLayout).
  // `connections`: the claim behind each tie, as a vault's graph observes them (lib/noteBriefing.ts reads them).
  const edges: GraphEdge[] = [], edgeAt = new Map<string, GraphEdge>(), degree = new Map<string, number>(), arrivals = new Map<string, string>();
  const connections: Array<{ from: string; to: string; evidence: ConnectionEvidence }> = [];
  const arrive = (key: string, at: string) => { const was = arrivals.get(key); if (was === undefined || at < was) arrivals.set(key, at); };
  const link = (a: string, b: string, claim: AssertionEvent) => {
    const at = claim.created_at, key = edgeKey(a, b), seen = edgeAt.get(key); arrive(key, at);
    connections.push({ from: a, to: b, evidence: { assertion: claim.id, text: claim.text } });
    if (seen) { seen.weight = (seen.weight ?? 1) + 1; return; }
    const edge: GraphEdge = { source: a, target: b }; edgeAt.set(key, edge); edges.push(edge);
    for (const end of [a, b]) degree.set(end, (degree.get(end) ?? 0) + 1);
  };
  for (const s of sources) arrive(`source:${s.id}`, received(s));
  for (const a of assertions) {
    const named = [...new Set(a.entities.map(e => e.id))];
    const cited = [...new Set(assertionSourceReferences(a).filter(ref => byId.has(ref.insertion_id)).map(ref => `source:${copyOf(ref.insertion_id)}`))];
    for (const id of named) { arrive(id, a.created_at); for (const source of cited) link(id, source, a); }
    for (let i = 0; i < named.length; i++) for (let j = i + 1; j < named.length; j++) link(named[i]!, named[j]!, a);
  }
  for (const node of nodes) node.degree = degree.get(node.id) ?? 0;
  // an entity that IS a landing opens it, and the landing draws as the entity
  for (const { entity, source } of bindings) {
    const e = nodes.find(n => n.id === entity), s = nodes.find(n => n.id === `source:${copyOf(source)}`);
    if (!e || !s) continue;
    e.opens = [...new Set([...(e.opens ?? []), s.id])]; s.drawnAs ??= e.id;
  }
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
  return { sources, assertions, identities, recent, note, arrivals, connections, graph: { nodes, edges, projection: 'assertions' as const, hash: sha256hex(JSON.stringify([sources, assertions, identities.map(e => e.id)])) } };
}

const fields = new Map<string, Graph>();
/** A server's own field, as everyone who reads it sees it: its record alone,
 * nothing of a reader's vault, laid out by when each part arrived. `you`
 * (your graph's `userNote`) leave your own view of it, as you leave your own
 * field (lib/assertionGraph.ts); every other place, line and size stays as
 * everyone sees it. */
export function serverField(view: ReturnType<typeof sharedProjection>, you?: Graph['userNote']): Graph {
  let field = fields.get(view.graph.hash);
  if (!field) {
    const at = fieldLayout(view.graph, view.arrivals);
    field = { ...view.graph, nodes: view.graph.nodes.map(n => ({ ...n, x: at[n.id]![0], y: at[n.id]![1] })) };
    if (fields.size >= 8) fields.delete(fields.keys().next().value!);
    fields.set(view.graph.hash, field);
  }
  const self = new Set(field.nodes.filter(n => n.entity && (isUserNode(n, you) || isUserNote(n.title, you))).map(n => n.id));
  return self.size ? { ...field, nodes: field.nodes.filter(n => !self.has(n.id)), edges: field.edges.filter(e => !self.has(e.source) && !self.has(e.target)) } : field;
}

/** `you`: who leaves your view of the server's field (serverField). */
export async function sharedWorkspace(req: IncomingMessage, res: ServerResponse, store = connectionStorePath(), you?: () => Promise<Graph['userNote']>): Promise<boolean> {
  let url: URL;
  try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { json(res, 400, { error: 'Invalid URL.' }); return true; }
  if (!url.pathname.startsWith('/api/')) return false;
  const selected = req.headers['x-bigbrain-workspace'] ?? url.searchParams.get('workspace');
  if (selected == null && url.pathname !== '/api/shared-connections') return false;
  try {
    if (url.pathname === '/api/shared-connections') {
      if (req.method === 'GET') json(res, 200, { connections: await refreshConnectionNames(store) });
      else if (req.method === 'POST') {
        const input=JSON.parse(await readBody(req,16384)), saved=input.invite?await connectInvite(store,input.invite):await saveConnection(store,input);
        followJoined(store,saved.id);
        json(res,201,saved);
      }
      else json(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    const connection = readConnections(store).find(c => c.id === selected);
    if (!connection) throw new SharedConnectionError(404, 'Shared connection not found.');
    const identity = `shared:${connection.id}`;
    if (!allowVaultRequest(req, res, identity)) return true;
    // A read answers from this computer's copy of the server (lib/serverStore.ts),
    // as its follower last synced it; only a write asks the server who you are.
    const held = readServer(store, connection.id);
    if (held.status.permissions && !held.status.permissions.includes('read')) throw new SharedConnectionError(403, 'Read access has been removed.');
    const writer = async () => {
      const who = await sharedRequest<SharedIdentity>(connection, '/v1/whoami');
      if (!who.permissions.includes('write')) throw new SharedConnectionError(403, 'This connection is read-only.');
    };
    const path = url.pathname;
    if (path === '/api/shared-identity' && req.method === 'GET') { json(res, 200, { ...publicConnection(connection), status: held.status }); return true; }
    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: vault\ndata: ${JSON.stringify(identity)}\n\n`);
      // Each window hears the follower land a new head; none asks the server.
      let head = -1;
      const heard = () => {
        const now = readServer(store, connection.id).snapshot?.head ?? -1;
        if (now !== head && !res.destroyed) { head = now; res.write(`event: views\ndata: ${JSON.stringify(sharedStamps(identity, head))}\n\n`); }
      };
      const stop = onServerChange(store, connection.id, heard); res.on('close', stop); heard(); return true;
    }
    if (path === '/api/shared/assertions' && req.method === 'GET') { json(res, 200, held.snapshot?.assertions ?? []); return true; }
    if (req.method === 'POST' && /^\/api\/shared\/assertions(?:\/ast_[a-f0-9]+\/(?:correct|retract))?$/.test(path)) {
      await writer();
      const said = await sharedRequest(connection, path.replace('/api/shared/', '/v1/'), JSON.parse(await readBody(req)));
      await followServer(store, connection); // what you wrote is in your copy before you read it
      json(res, 200, said); return true;
    }
    if (req.method === 'POST') {
      await writer();
      if (path === '/api/drop') {
        const body = JSON.parse(await readBody(req));
        if (body.attachments?.length) throw new SharedConnectionError(400, 'Servers currently accept text and Markdown files. Attachments are not supported yet.');
        const receipt = await sharedRequest<{ id: string; source_id: string }>(connection, '/v1/evidence', { title: body.name, body: body.content });
        const source = await sharedRequest<SourceInsertion>(connection, `/v1/evidence/${receipt.id}`);
        await followServer(store, connection);
        json(res, 200, { id: receipt.source_id, path: insertionEventRel(source), ref_path: insertionEventRel(source), via: 'shared' }); return true;
      }
      throw new SharedConnectionError(403, 'This action is not available on servers yet.');
    }
    if (req.method !== 'GET') throw new SharedConnectionError(405, 'Method not allowed.');
    // Only explicit, inert compatibility responses. All other routes fail closed.
    const empty: Record<string, unknown> = {
      '/api/setup': null, '/api/telemetry': null, '/api/source/read-state': { sources: [] }, '/api/pilot/chat': { sessions: [] }, '/api/pilot/work': { sessions: [] },
      '/api/note-log': { entries: [] }, '/api/entity/folds': { groups: [], proposedAt: null },
      // which vault this is rides on the header; the body says nothing more
      '/api/vault': {},
    };
    if (path in empty) { json(res, 200, empty[path]); return true; }
    if (!['/api/recent','/api/graph','/api/note','/api/search'].includes(path)) throw new SharedConnectionError(403, 'This feature is unavailable on servers.');
    const sources: SharedSource[] = [...held.snapshot?.evidence ?? []];
    if (path === '/api/note') {
      const id = url.searchParams.get('path')?.match(/(ins_[a-f0-9]{24})\.json$/)?.[1];
      const index = sources.findIndex(s => s.id === id);
      if (index >= 0) sources[index] = { ...sources[index]!, body: serverBody(store, connection.id, id!) ?? '' };
    }
    const view = path === '/api/note' ? sharedProjection(sources, held.snapshot?.assertions ?? [], held.snapshot?.identities ?? []) : viewOf(connection, store);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0), limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    if (path === '/api/graph') json(res, 200, serverField(view, await you?.()));
    else if (path === '/api/recent') json(res, 200, { recent: view.recent.slice(offset, offset+limit), total: sources.length, nextOffset: offset+limit < sources.length ? offset+limit : null });
    else if (path === '/api/note') { const note = view.note(url.searchParams.get('path') ?? ''); json(res, note ? 200 : 404, note ?? { error: 'Not found.' }); }
    else {
      const q = url.searchParams.get('q') ?? '', words = q.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      const matched = new Map<string, string>();
      for (const { source, snippet } of serverMatches(connection, view, q)) matched.set(`source:${source.id}`, snippet);
      // a claim that holds every word lights its entities and its sources
      for (const a of view.assertions) {
        if (!words.length || !words.every(w => a.text.toLocaleLowerCase().includes(w))) continue;
        for (const e of a.entities) if (!matched.has(e.id)) matched.set(e.id, a.text);
        for (const r of assertionSourceReferences(a)) if (!matched.has(`source:${r.insertion_id}`)) matched.set(`source:${r.insertion_id}`, a.text);
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

/** A joined vault's views move together, with its feed head (lib/viewStamps.ts). */
function sharedStamps(identity: string, head: number): import('./viewStamps').ViewStamps {
  const at = String(head);
  return { generation: identity, revision: at, views: { graph: at, joined: '', feed: at, folds: at, files: at } };
}
