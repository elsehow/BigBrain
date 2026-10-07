// Dev/test only: the base with Field on top, over a fabricated vault (every
// name here is invented). The rest of the engine is fakeApi's, through the
// graph fixture; this answers what only Field asks: the entity graph, the
// record, the sorted feed and the coding desktops. `?empty` is a new vault;
// `?view=field` keeps the browser suite's `?view=classic` off it; `?update`
// shows the update banner, `?credits` a provider out of usage credits beside it,
// `?working` a Desktop at work (its cube turning). `?reading` puts the
// Desktops among what they concern: one reads its way across the field, a
// note every few seconds (entities and sources, one of them older than the
// sorted feed), so its place can be watched moving; one concerns both sides
// of the field (some entities twice, which count once); one has nothing
// placeable yet. It also has an entity that is really a source (a paper
// taken for its own subject), drawn as one node that opens the paper. `?twins` gives three entities one name (Wren Hollis, kept for
// its ties; Wren-Hollis; wren hollis) and a three-way fold proposal (Kestrel
// Books, the pick; Kestrel Bookshop; Kestrel Books Ltd), for Merge?'s Accept and
// Reject; an accept here takes the merged ones off the field, as the engine's
// alias would. `?churn` changes the graph every few seconds, with a change ping,
// as tend filing in the background does: the field is redrawn under you.
// `?hostRequest` has a coding desktop whose agent asks to reach a site, and
// the chat's card until you answer; `?hostRequest=untrusted`, one that read
// content from outside you.
import { mount } from "svelte";
import "../design/tokens.css";
import "../app.css";
import Base from "../components/Base.svelte";
import { installGraphFixture } from "./graphFixture";
import { watchSystemTheme } from "../lib/theme";
import { update } from "../lib/update.svelte";

const empty = new URLSearchParams(location.search).has("empty");
if (new URLSearchParams(location.search).has("update")) update.available = { version: "0.7.24", notes: "Preview update" };
await installGraphFixture();

const NAMES = ["Orrery repair", "Atlas survey", "Kit Brennan", "Briar Lowe", "Harbor lab", "Ridgeway trail", "Lantern grant", "Quill press", "Tidewater review", "Marlow studio"];
const entities = empty ? [] : NAMES.map((title, i) => ({ id: `ent_${i}`, title, group: "entity", entity: true as const, degree: 10 - i,
  path: `projection/entities/ent_${i}.md`, x: Math.cos(i * 0.9) * (80 + i * 18), y: Math.sin(i * 0.9) * (80 + i * 18) }));
const twinScene = new URLSearchParams(location.search).has("twins");
const hex = (c: string) => `ent_${c.repeat(20)}`;
const TWINS = twinScene ? [
  { id: hex("a"), title: "Wren-Hollis", group: "entity", entity: true as const, degree: 2, path: `projection/entities/${hex("a")}.md`, x: 150, y: 60 },
  { id: hex("b"), title: "Wren Hollis", group: "entity", entity: true as const, degree: 7, path: `projection/entities/${hex("b")}.md`, x: -60, y: 120 },
  { id: hex("c"), title: "Kestrel Books", group: "entity", entity: true as const, degree: 6, path: `projection/entities/${hex("c")}.md`, x: 90, y: -110 },
  { id: hex("d"), title: "Kestrel Books Ltd", group: "entity", entity: true as const, degree: 1, path: `projection/entities/${hex("d")}.md`, x: -140, y: -40 },
  { id: hex("e"), title: "wren hollis", group: "entity", entity: true as const, degree: 1, path: `projection/entities/${hex("e")}.md`, x: 30, y: 170 },
  { id: hex("f"), title: "Kestrel Bookshop", group: "entity", entity: true as const, degree: 3, path: `projection/entities/${hex("f")}.md`, x: 170, y: -20 },
] : [];
let apart: Array<[string, string]> = [];
let proposals = twinScene ? [{ canonical: hex("c"), why: "the same bookshop, its registered name",
  members: [{ id: hex("c"), label: "Kestrel Books", assertions: 6 }, { id: hex("f"), label: "Kestrel Bookshop", assertions: 3 },
    { id: hex("d"), label: "Kestrel Books Ltd", assertions: 1 }] }] : [];
const memory = empty ? [] : [{ id: "memory/atlas.md", title: "Atlas", group: "memory", degree: 3, path: "memory/atlas.md", x: 40, y: -30 }];
let graph = { hash: empty ? "empty" : "field", nodes: [...entities, ...TWINS, ...memory],
  edges: empty ? [] : [...NAMES.slice(1).map((_, i) => ({ source: `ent_${i}`, target: `ent_${i + 1}`, weight: 2 })),
    ...TWINS.map((t, i) => ({ source: t.id, target: `ent_${i + 1}`, weight: 1 }))] };
if (new URLSearchParams(location.search).has("churn")) {
  let n = 0;
  setInterval(() => { graph = { ...graph, hash: `${graph.hash.split("~")[0]}~${++n}` }; window.dispatchEvent(new Event("workbench-change")); }, 4000);
}
const at = (min: number) => new Date(Date.UTC(2026, 9, 5, 9, min)).toISOString();
const hostScene = new URLSearchParams(location.search).has("hostRequest");
const hostUntrusted = new URLSearchParams(location.search).get("hostRequest") === "untrusted";
let hostAnswer = "";
const HOST_DESK = { id: "d-0000beef", kind: "coding", title: "Tide calculator", titleSource: "human", model: "claude-opus-5-5", phase: "answered",
  lifecycle: "active", created: at(20), updated: at(22), lastActivityAt: at(22), contextNodes: [] };
const feed = empty ? [] : NAMES.slice(0, 4).map((name, i) => ({ id: `ast_${i}`, at: at(i), author: null, by: "you", model: false, text: `${name} was noted.`, entities: [`ent_${i}`] }));
const sorted = empty ? [] : [
  { source: "ins_a", section: "needs-you", headline: "Kit asks for the orrery repair estimate by Friday.", due: null, added: at(30), entities: ["ent_0", "ent_2"],
    title: "Orrery estimate", path: "log/insertions/2026-10/ins_a.json", via: "email" },
  { source: "ins_b", section: "know", headline: "The Atlas survey's second leg is complete.", due: null, added: at(20), entities: ["ent_1"],
    title: "Atlas survey update", path: "log/insertions/2026-10/ins_b.json", via: "rss" },
  { source: "ins_c", section: "agent", headline: "Harbor lab sent the grant draft for review.", due: null, added: at(10), entities: ["ent_4", "ent_6"],
    title: "Lantern grant draft", path: "log/insertions/2026-10/ins_c.json", via: "email" },
];

let outOfCredits = new URLSearchParams(location.search).has("credits");
const reading = new URLSearchParams(location.search).has("reading");
// a paper the gardener took for its own subject, every claim "[[it]] found
// …": /api/graph links the pair (the entity's `opens`, the source's `drawnAs`)
const PAPER = reading && !empty ? { id: "ent_paper", title: "Tidal Rhythm Exposure and Shorebird Foraging Outcomes Across Twelve Estuary Sites: A Longitudinal Survey",
  group: "entity", entity: true as const, degree: 3, path: "projection/entities/ent_paper.md", x: -60, y: -20, opens: ["source:ins_p"] } : null;
if (PAPER) {
  sorted.push({ source: "ins_p", section: "know", headline: "A twelve-site survey of shorebird foraging and tidal rhythm was filed.", due: null, added: at(5),
    entities: [PAPER.id, "ent_3", "ent_4"], title: "Shorebird foraging survey (preprint)", path: "log/insertions/2026-10/ins_p.json", via: "drop" });
  graph = { ...graph, nodes: [...graph.nodes, PAPER],
    edges: [...graph.edges, { source: PAPER.id, target: "ent_4", weight: 2 }, { source: PAPER.id, target: "ent_3", weight: 1 }] };
}
// a walk across the field: Harbor lab's side, then down past Kit to the orrery
const WALK = ["ent_4", "log/insertions/2026-10/ins_c.json", "ent_6", "log/insertions/2026-08/ins_old.json", "ent_3", "ent_2", "log/insertions/2026-10/ins_a.json", "ent_0", "ent_1", "ent_7"];
// what the engine knows of each source (lib/contextSources.ts): the sorted
// feed's, and one from before the feed began
const SOURCES = [...sorted.map((r) => ({ id: r.source, path: r.path, title: r.title, entities: r.entities })),
  { id: "ins_old", path: "log/insertions/2026-08/ins_old.json", title: "Ridgeway trail notes", entities: ["ent_5", "ent_7"] }];
// /api/graph draws every source as a node of its own, tied to what it
// mentions; the field shows them at rest when Settings → Graph says so
if (!empty) {
  const more = [
    { id: "ins_d", path: "log/insertions/2026-09/ins_d.json", title: "Quill press invoice", entities: ["ent_7"] },
    { id: "ins_e", path: "log/insertions/2026-09/ins_e.json", title: "Call with Kit Brennan", entities: ["ent_2", "ent_0", "ent_3"] },
    { id: "ins_f", path: "log/insertions/2026-09/ins_f.json", title: "Marlow studio newsletter", entities: ["ent_9", "ent_8"] },
    { id: "ins_g", path: "log/insertions/2026-09/ins_g.json", title: "Tidewater review minutes", entities: ["ent_8", "ent_3", "ent_1"] },
    { id: "ins_h", path: "log/insertions/2026-09/ins_h.json", title: "Lantern grant budget", entities: ["ent_6", "ent_4"] },
  ];
  const all = [...SOURCES, ...more], pos = new Map([...entities, ...(PAPER ? [PAPER] : [])].map((e) => [e.id, e]));
  const nodes = all.map((src, k) => {
    const on = src.entities.map((id) => pos.get(id)!);
    const x = on.reduce((t, e) => t + e.x, 0) / on.length + Math.cos(k * 2.4) * 22, y = on.reduce((t, e) => t + e.y, 0) / on.length + Math.sin(k * 2.4) * 22;
    const drawnAs = PAPER?.opens.includes(`source:${src.id}`) ? { drawnAs: PAPER.id } : {};
    return { id: `source:${src.id}`, title: src.title!, group: "source", degree: src.entities.length, path: src.path!, x, y, ...drawnAs };
  });
  graph = { ...graph, nodes: [...graph.nodes, ...nodes],
    edges: [...graph.edges, ...all.flatMap((src) => src.entities.map((target) => ({ source: `source:${src.id}`, target, weight: 1 })))] };
}
const started = Date.now();
const READ_MS = 2500;
const CONTEXT: Record<string, () => string[]> = {
  "Atlas planning": () => WALK.slice(0, 1 + (Math.floor((Date.now() - started) / READ_MS) % WALK.length)),
  "Component audit": () => ["ent_9", "ent_8", "ent_8", "ent_9", "ent_3", "ent_2", "ins_b", "ent_2"],
  "Earlier project review": () => [],
};
const fake = window.fetch;
(window as unknown as { fetch: typeof fake }).fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/api/graph") return json(graph);
  // recents from this vault, not the fixture's: what search lists before you type
  if (url.pathname === "/api/recent") {
    const rows = [...sorted.map((r) => ({ path: r.path, title: r.title, modified: Date.parse(r.added), author: "intake", action: "added", band: "service" })),
      ...graph.nodes.filter((n) => n.path).map((n, i) => ({ path: n.path, title: n.title, modified: Date.parse(at(0)) - i * 60_000, author: "gardener", action: "added", band: "engine" }))]
      .sort((a, b) => b.modified - a.modified);
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 40);
    return json({ recent: rows.slice(offset, offset + limit), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null });
  }
  if (twinScene && url.pathname === "/api/entity/folds") return json({ proposedAt: "2026-10-05T09:00:00.000Z", model: "claude-x", groups: proposals, rejected: apart });
  if (twinScene && url.pathname === "/api/entity/folds/reject") {
    const { member, others } = JSON.parse(String(init?.body ?? "{}")) as { member: string; others: string[] };
    apart = [...apart, ...others.map((o): [string, string] => (member < o ? [member, o] : [o, member]))];
    // a refused pair splits off: the member leaves the group (as the engine's validation splits it)
    proposals = proposals.map((g) => g.members.some((m) => m.id === member) && g.members.some((m) => others.includes(m.id))
      ? { ...g, members: g.members.filter((m) => m.id !== member), canonical: g.canonical === member ? others[0]! : g.canonical } : g).filter((g) => g.members.length > 1);
    const label = (id: string) => graph.nodes.find((n) => n.id === id)?.title ?? id;
    return json({ member: { id: member, label: label(member) }, against: others.map((id) => ({ id, label: label(id) })) });
  }
  if (twinScene && url.pathname === "/api/entity/folds/accept") {
    const { canonical, members } = JSON.parse(String(init?.body ?? "{}")) as { canonical: string; members: string[] };
    const gone = new Set(members), label = (id: string) => graph.nodes.find((n) => n.id === id)?.title ?? id;
    const done = { canonical: { id: canonical, label: label(canonical) }, aliased: members.map((id) => ({ id, label: label(id) })) };
    graph = { ...graph, hash: `${graph.hash}-${members.join()}`, nodes: graph.nodes.filter((n) => !gone.has(n.id)),
      edges: graph.edges.map((e) => ({ ...e, source: gone.has(e.source) ? canonical : e.source, target: gone.has(e.target) ? canonical : e.target })) };
    proposals = proposals.map((g) => ({ ...g, members: g.members.filter((m) => !gone.has(m.id)),
      canonical: gone.has(g.canonical) ? canonical : g.canonical })).filter((g) => g.members.length > 1);
    return json(done);
  }
  if (url.pathname === "/api/v2") return json({ authors: [], feed });
  if (url.pathname === "/api/v2/sorted") return json({ rows: sorted });
  if (url.pathname === "/api/v2/entity") return json({ rows: feed.filter((r) => r.entities.includes(url.searchParams.get("id") ?? "")) });
  if (url.pathname === "/api/desktops") return json({ desktops: hostScene ? [HOST_DESK] : [] });
  // `?hostRequest`: a coding desktop whose agent asks to reach a site, until you answer
  if (hostScene && url.pathname === "/api/desktops/session") return json({ ...HOST_DESK, seq: 4, changes: [], servers: [],
    messages: [
      { id: "in-1", role: "user", text: "Add this month's tide tables to the calculator.", at: at(20) },
      { id: "a2", role: "activity", text: "Ran python3 fetch_tides.py", at: at(21), ok: true },
      { id: "a3", role: "activity", text: "Asked to reach data.tides.example", at: at(22), ok: true },
      { id: "m4", role: "assistant", text: "The sandbox refused data.tides.example, where the tables are published. I've asked you to allow it.", at: at(22) },
      ...hostAnswer ? [{ id: "in-5", role: "user", text: hostAnswer, at: at(23) }] : [],
    ],
    ...hostAnswer ? {} : { hostRequest: { host: "data.tides.example", reason: "The script downloads this month's tide tables from it.", untrusted: hostUntrusted } } });
  if (hostScene && url.pathname === "/api/desktops/answer-host") {
    const { answer } = JSON.parse(String(init?.body ?? "{}")) as { answer: string };
    hostAnswer = answer === "no" ? "Didn't allow data.tides.example." : `Allowed data.tides.example for ${answer === "all" ? "every desktop" : "this desktop"}.`;
    return json(HOST_DESK);
  }
  // a new desktop is counted (the browser suite reads it), not started
  if (url.pathname === "/api/desktops/create") {
    const w = window as unknown as { desktopsCreated?: number };
    w.desktopsCreated = (w.desktopsCreated ?? 0) + 1;
    return json({ error: "The workbench starts no desktops." }, 501);
  }
  if (reading && url.pathname === "/api/pilot/chat" && !init?.body) {
    const body = await (await fake(input, init)).json() as { sessions: Array<{ title: string; context?: string[]; contextNodes?: unknown[]; phase?: string }> };
    for (const s of body.sessions) {
      const ctx = CONTEXT[s.title];
      if (!ctx) continue;
      s.context = ctx();
      s.contextNodes = SOURCES.filter((src) => s.context!.includes(src.id) || s.context!.includes(src.path))
        .map((src) => ({ id: s.context!.includes(src.id) ? src.id : src.path, path: src.path, title: src.title, group: "source", entities: src.entities }));
      if (s.title === "Atlas planning") s.phase = "working";
    }
    return json(body);
  }
  // `?credits`: the gardener's provider is out of usage credits until Retry
  if (url.pathname === "/api/credits/retry") { outOfCredits = false; return json({ providers: {} }); }
  if (url.pathname === "/api/credits") return json({ providers: outOfCredits ? { anthropic: { since: at(0), at: at(5), roles: ["tend", "quick"], detail: "Your credit balance is too low." } } : {} });
  const note = url.pathname === "/api/note" ? sorted.find((r) => r.path === url.searchParams.get("path")) : undefined;
  if (note) return json({ path: note.path, kind: "markdown", content: `# ${note.title}\n\n${note.headline}`, origin: { kind: "url", url: `https://example.com/${note.source}` } });
  if (url.pathname === "/api/note/briefing") return json({ error: "no briefings here" }, 404);
  return fake(input, init);
}) as typeof fake;

watchSystemTheme();
// unpinned, as the app mounts it: Field unless the address says ?view=classic
mount(Base, { target: document.getElementById("app")! });
